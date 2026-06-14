import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  groupTasksByState,
  TASK_STATE_LABELS,
  type AppServerInstanceSummary,
  type AppServerInstancesUpdatePayload,
  type BootstrapPayload,
  type CommandSummary,
  type ConnectorSummary,
  type ConnectorsUpdatePayload,
  type CreateLocalThreadResponse,
  type HostSessionsUpdatePayload,
  type HostSessionSummary,
  type TaskState,
  type TaskSummary,
  type ThreadEvent,
  type ThreadSummary
} from "@chaop/protocol";
import {
  ApiError,
  archiveTask,
  attachHostSession,
  browserSocketUrl,
  createCommand,
  createLocalThread,
  detachHostSession,
  loadBootstrap,
  loadThreadEvents,
  refreshHostSessions,
  unarchiveTask
} from "./api.js";
import {
  appServerInstanceStateLabel,
  appServerInstancesForConnector,
  archiveSyncNotice,
  archiveSyncWarning,
  codexCliFallbackAvailable,
  commandExecutionModeForRequest,
  commandModeLabel,
  commandTypeForMode,
  historyBackfillNotice,
  localThreadConnectorId,
  localThreadConnectors,
  localThreadWorkspaceId,
  MANAGED_APP_SERVER_UNAVAILABLE,
  managedAppServerCommandAvailable,
  mergeBootstrapPayload,
  mergeAppServerInstances,
  mergeConnectorSummaries,
  primaryAppServerInstanceForConnector,
  normaliseCommandMode,
  type CommandExecutionMode
} from "./state.js";

type View = "operations-map" | "task-board" | "host-sessions" | "thread-centre" | "budget-board";
type TaskBoardMode = "active" | "archive";
type RealtimeState = "connecting" | "live" | "polling";
type RealtimeThreadEventPayload = {
  event: ThreadEvent;
};
type RealtimeConnectorsPayload = ConnectorsUpdatePayload;
type RealtimeHostSessionsPayload = HostSessionsUpdatePayload;
type RealtimeAppServerInstancesPayload = AppServerInstancesUpdatePayload;

const FALLBACK_POLL_MS = 10_000;
const SOCKET_RECONNECT_MS = 3_000;
const SHOW_CODEX_CLI_FALLBACK = import.meta.env.VITE_CHAOP_SHOW_CODEX_CLI_FALLBACK === "true";

@customElement("chaop-app")
export class ChaopApp extends LitElement {
  static override styles = css``;

  @state()
  private data?: BootstrapPayload;

  @state()
  private view: View = "operations-map";

  @state()
  private selectedThreadId: string | undefined;

  @state()
  private taskBoardMode: TaskBoardMode = "active";

  @state()
  private commandPrompt = "Summarise the current failure pattern and next action.";

  @state()
  private commandMode: CommandExecutionMode = "placeholder";

  @state()
  private commandState: "idle" | "submitting" | "accepted" | "failed" = "idle";

  @state()
  private lastCommandId: string | undefined;

  @state()
  private loadError: string | undefined;

  @state()
  private actionError: string | undefined;

  @state()
  private actionNotice: string | undefined;

  @state()
  private realtimeState: RealtimeState = "connecting";

  @state()
  private hostSessionsRefreshState: "idle" | "refreshing" | "failed" = "idle";

  @state()
  private hostSessionsRefreshSummary: string | undefined;

  @state()
  private newThreadTitle = "New Codex thread";

  @state()
  private newThreadConnectorId = "";

  @state()
  private newThreadState: "idle" | "creating" | "failed" = "idle";

  @state()
  private hostSessionsRealtimeSyncedAt: string | undefined;

  @state()
  private clockNow = Date.now();

  private socket: WebSocket | undefined;

  private pollTimer: number | undefined;

  private reconnectTimer: number | undefined;

  private clockTimer: number | undefined;

  override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.view = viewFromHash();
    this.selectedThreadId = threadIdFromHash();
    window.addEventListener("hashchange", this.onHashChange);
    void this.load().then(() => {
      if (this.data) {
        this.ensureSelectedThread();
        this.connectRealtime();
      }
    });
    this.clockTimer = window.setInterval(() => {
      this.clockNow = Date.now();
    }, 10_000);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.onHashChange);
    window.clearInterval(this.clockTimer);
    this.disconnectRealtime();
    super.disconnectedCallback();
  }

  override render() {
    if (this.loadError) {
      return html`<main class="loading error-state">
        <strong>Control plane is unavailable</strong>
        <span>${this.loadError}</span>
      </main>`;
    }

    if (!this.data) {
      return html`<main class="loading">Loading control plane...</main>`;
    }

    return html`
      <div class="shell">
        <aside class="sidebar">
          <div class="brand">
            <span class="mark">C</span>
            <div>
              <strong>Chaop</strong>
              <span>Control plane</span>
            </div>
          </div>
          <nav>
            ${this.navItem("operations-map", "Operations Map")}
            ${this.navItem("task-board", "Task Board")}
            ${this.navItem("host-sessions", "Host Sessions")}
            ${this.navItem("thread-centre", "Thread Centre")}
            ${this.navItem("budget-board", "Budget Board")}
          </nav>
        </aside>
        <main>
          ${this.renderTopBar()}
          ${this.actionError ? html`<div class="action-alert" role="alert">${this.actionError}</div>` : nothing}
          ${this.actionNotice ? html`<div class="action-notice" role="status">${this.actionNotice}</div>` : nothing}
          ${this.view === "operations-map" ? this.renderOperationsMap() : nothing}
          ${this.view === "task-board" ? this.renderTaskBoard() : nothing}
          ${this.view === "host-sessions" ? this.renderHostSessions() : nothing}
          ${this.view === "thread-centre" ? this.renderThreadCentre() : nothing}
          ${this.view === "budget-board" ? this.renderBudgetBoard() : nothing}
        </main>
      </div>
    `;
  }

  private async load(): Promise<void> {
    try {
      const incoming = await loadBootstrap();
      this.data = mergeBootstrapPayload(this.data, incoming);
      this.loadError = undefined;
      this.ensureSelectedThread();
      await this.loadSelectedThreadEvents().catch((error) => {
        this.actionError = actionErrorMessage("Thread events refresh failed", error);
      });
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : "Bootstrap request failed";
    }
  }

  private readonly onHashChange = (): void => {
    this.view = viewFromHash();
    this.selectedThreadId = threadIdFromHash();
    this.ensureSelectedThread();
    void this.loadSelectedThreadEvents().catch((error) => {
      this.actionError = actionErrorMessage("Thread events refresh failed", error);
    });
  };

  private navItem(view: View, label: string) {
    return html`
      <a class=${this.view === view ? "active" : ""} href=${`#${view}`}>${label}</a>
    `;
  }

  private renderTopBar() {
    const budget = this.data!.budget;
    return html`
      <header class="topbar">
        <div>
          <strong>${viewTitle(this.view)}</strong>
          <span>${viewQuestion(this.view)}</span>
        </div>
        <div class="topbar-status">
          <span class="chip ${this.realtimeState}">${realtimeLabel(this.realtimeState)}</span>
          <span class="chip ${budget.state}">4h ${budget.four_hour_used_pct}%</span>
          <span class="chip ${budget.state}">Day ${budget.daily_used_pct}%</span>
          <span class="identity">${this.data!.user.email}</span>
        </div>
      </header>
    `;
  }

  private renderOperationsMap() {
    const appServerInstances = this.appServerInstancesForDisplay();
    return html`
      <section class="page-grid map-grid">
        <section class="panel primary">
          <div class="section-heading">
            <h2>Fleet health</h2>
            <span>${this.data!.connectors.length} connectors</span>
          </div>
          <div class="table">
            ${this.data!.connectors.map((connector) => this.connectorRow(connector))}
          </div>
        </section>
        <aside class="panel">
          <div class="section-heading">
            <h2>App-server instances</h2>
            <span>${appServerInstances.length} reported</span>
          </div>
          <div class="instance-list">
            ${appServerInstances.length > 0
              ? appServerInstances.map((instance) => this.appServerInstanceCard(instance, "full"))
              : html`<p class="muted">No app-server instances reported by connectors.</p>`}
          </div>
        </aside>
      </section>
    `;
  }

  private connectorRow(connector: ConnectorSummary) {
    return html`
      <div class="row connector-row">
        <div>
          <strong>${connector.name}</strong>
          <span>${connector.hostname}</span>
        </div>
        <span class="status ${connector.status}">${connector.status}</span>
        <span>${connector.logical_agent_count} agents · ${connector.active_command_count} running</span>
        <span class="chip ${connector.realtime_mode}">${formatMode(connector.realtime_mode)}</span>
      </div>
    `;
  }

  private renderTaskBoard() {
    const visibleTasks = this.data!.tasks.filter((task) =>
      this.taskBoardMode === "archive" ? task.archived_at : !task.archived_at
    );
    const grouped = groupTasksByState(visibleTasks);
    const states: TaskState[] = [
      "running",
      "idle",
      "waiting_for_approval",
      "waiting_for_input",
      "throttled",
      "failed",
      "done"
    ];

    return html`
      <section class="task-layout">
        <div class="board-toolbar">
          <div class="category-strip">
            ${this.data!.task_categories.map(
              (category) => html`<span style=${`--category:${category.colour}`}>${category.name}</span>`
            )}
          </div>
          ${this.renderCreateThreadForm("compact")}
          <div class="mode-control compact" role="group" aria-label="Task board mode">
            ${this.taskBoardModeButton("active", "Active")}
            ${this.taskBoardModeButton("archive", "Archive")}
          </div>
        </div>
        <div class="board">
          ${states.map(
            (stateName) => html`
              <section class="swimlane">
                <header>
                  <strong>${TASK_STATE_LABELS[stateName]}</strong>
                  <span>${grouped[stateName].length}</span>
                </header>
                ${grouped[stateName].map((task) => this.taskCard(task))}
              </section>
            `
          )}
        </div>
      </section>
    `;
  }

  private taskCard(task: TaskSummary) {
    const category = this.data!.task_categories.find((item) => item.id === task.category_id);
    return html`
      <article class="task-card" @click=${() => this.openThread(task.thread_id)}>
        <div class="task-title">
          <strong>${task.title}</strong>
          <span style=${`--category:${category?.colour ?? "#64748b"}`}>${category?.name ?? "Uncategorised"}</span>
        </div>
        <div class="task-meta">
          <span>${task.assigned_agent ?? "Unassigned"}</span>
          <span class="chip ${task.realtime_mode}">${formatMode(task.realtime_mode)}</span>
        </div>
        <div class="task-actions">
          <button
            type="button"
            @click=${(event: Event) => {
              event.stopPropagation();
              void this.toggleTaskArchive(task);
            }}
          >
            ${task.archived_at ? "Unarchive" : "Archive"}
          </button>
        </div>
      </article>
    `;
  }

  private taskBoardModeButton(mode: TaskBoardMode, label: string) {
    return html`
      <button
        type="button"
        class=${this.taskBoardMode === mode ? "active" : ""}
        @click=${() => {
          this.taskBoardMode = mode;
        }}
      >
        ${label}
      </button>
    `;
  }

  private renderThreadCentre() {
    const thread = this.selectedThread();
    if (!thread) return this.renderEmptyThreadCentre();
    const task = this.taskForThread(thread.id);
    const events = this.eventsForThread(thread.id);
    const command = this.lastCommandId
      ? this.data!.running_commands.find((item) => item.id === this.lastCommandId)
      : this.data!.running_commands[0];

    return html`
      <section class="page-grid thread-grid">
        <section class="panel primary">
          <div class="section-heading">
            <h2>${thread.title}</h2>
            <div class="section-actions">
              ${task
                ? html`
                    <button type="button" @click=${() => void this.toggleTaskArchive(task)}>
                      ${task.archived_at ? "Unarchive" : "Archive"}
                    </button>
                  `
                : nothing}
              <span class="chip ${thread.realtime_mode}">${formatMode(thread.realtime_mode)}</span>
            </div>
          </div>
          <label class="command-box">
            <span>Command</span>
            <textarea
              .value=${this.commandPrompt}
              @input=${(event: InputEvent) => {
                this.commandPrompt = (event.target as HTMLTextAreaElement).value;
              }}
            ></textarea>
          </label>
          <div class="mode-control" role="group" aria-label="Execution mode">
            ${this.commandModeButton("placeholder")}
            ${managedAppServerCommandAvailable(this.data, thread.id) ? this.commandModeButton("app_server") : nothing}
            ${SHOW_CODEX_CLI_FALLBACK && codexCliFallbackAvailable(this.data, thread.workspace_id)
              ? this.commandModeButton("codex_cli_fallback")
              : nothing}
          </div>
          <button
            class="primary-action"
            type="button"
            ?disabled=${this.commandState === "submitting" || this.commandPrompt.trim().length === 0}
            @click=${this.submitCommand}
          >
            ${this.commandState === "submitting" ? "Submitting..." : `Run ${commandModeLabel(this.commandMode)} command`}
          </button>
          ${this.commandState === "accepted"
            ? html`<p class="command-status success">
                ${commandModeLabel(this.commandMode)} command accepted${this.lastCommandId ? `: ${this.lastCommandId}` : ""}.
              </p>`
            : nothing}
          ${this.commandState === "failed"
            ? html`<p class="command-status failed">Command request failed.</p>`
            : nothing}
          <div class="timeline">
            ${events.length > 0
            ? events.map(
                  (event) => html`
                    <div class="event-row">
                      <span>${String(event.seq).padStart(2, "0")}</span>
                      <strong>${event.kind}</strong>
                      <p>${event.summary}</p>
                    </div>
                  `
                )
              : html`<p class="muted">No events recorded for this thread yet.</p>`}
          </div>
        </section>
        <aside class="panel">
          <div class="section-heading">
            <h2>Threads</h2>
            <span>${this.activeThreads().length} active</span>
          </div>
          ${this.renderCreateThreadForm("stacked", thread.id)}
          <div class="thread-list">
            ${this.activeThreads().map((item) => this.threadListItem(item))}
          </div>
          <div class="section-heading">
            <h2>Lease</h2>
            <span>${commandModeLabel(this.commandMode)} target</span>
          </div>
          <dl class="facts">
            <div><dt>Mode</dt><dd>Interactive</dd></div>
            <div><dt>Execution</dt><dd>${command ? formatCommandExecution(command) : commandModeLabel(this.commandMode)}</dd></div>
            <div><dt>Target</dt><dd>${command?.target_connector_id ?? "Auto-selected"}</dd></div>
            <div><dt>Command state</dt><dd>${command?.state ?? "No live command"}</dd></div>
            <div><dt>Task</dt><dd>${task?.title ?? "Thread only"}</dd></div>
            <div><dt>Policy</dt><dd>Realtime events, summary logs</dd></div>
            <div><dt>Approval</dt><dd>Connector-gated</dd></div>
            <div><dt>Artifacts</dt><dd>Entry point only</dd></div>
          </dl>
        </aside>
      </section>
    `;
  }

  private renderEmptyThreadCentre() {
    return html`
      <section class="page-grid thread-grid">
        <section class="panel primary empty-state">
          <div class="section-heading">
            <h2>No thread selected</h2>
            <span class="chip ${this.realtimeState}">${realtimeLabel(this.realtimeState)}</span>
          </div>
          <p>Waiting for connector activity.</p>
        </section>
        <aside class="panel">
          <div class="section-heading">
            <h2>Lease</h2>
            <span>Idle</span>
          </div>
          <dl class="facts">
            <div><dt>Mode</dt><dd>Idle</dd></div>
            <div><dt>Execution</dt><dd>No live command</dd></div>
            <div><dt>Target</dt><dd>Auto-selected</dd></div>
            <div><dt>Command state</dt><dd>Waiting</dd></div>
          </dl>
        </aside>
      </section>
    `;
  }

  private renderHostSessions() {
    const attached = this.data!.host_sessions.filter((session) => this.isActiveAttachedHostSession(session));
    const unattached = this.data!.host_sessions.filter((session) => !session.attached_thread_id);
    const lastSyncedAt = this.hostSessionsLastSyncedAt();
    const appServerInstances = this.appServerInstancesForDisplay();

    return html`
      <section class="page-grid sessions-grid">
        <section class="panel primary">
          <div class="section-heading">
            <h2>Unattached sessions</h2>
            <div class="section-actions host-sync-actions">
              <button
                type="button"
                ?disabled=${this.hostSessionsRefreshState === "refreshing"}
                @click=${this.refreshHostSessionInventory}
              >
                ${this.hostSessionsRefreshState === "refreshing" ? "Refreshing..." : "Refresh"}
              </button>
              <span class="sync-meta">${formatSyncStatus(lastSyncedAt, this.clockNow)}</span>
              <span>${unattached.length} available</span>
            </div>
          </div>
          <div class="session-list">
            ${unattached.length > 0
              ? unattached.map((session) => this.hostSessionRow(session))
              : html`<p class="muted">No unattached local Codex sessions reported by connectors.</p>`}
          </div>
          ${this.hostSessionsRefreshSummary
            ? html`<p class="sync-note">${this.hostSessionsRefreshSummary}</p>`
            : nothing}
        </section>
        <aside class="panel">
          <div class="section-heading">
            <h2>Attached</h2>
            <span>${attached.length} sessions</span>
          </div>
          <div class="session-list compact-list">
            ${attached.map((session) => this.hostSessionRow(session))}
          </div>
          <div class="section-heading">
            <h2>App-server</h2>
            <span>${appServerInstances.length} instances</span>
          </div>
          <div class="instance-list compact-instance-list">
            ${appServerInstances.length > 0
              ? appServerInstances.map((instance) => this.appServerInstanceCard(instance, "compact"))
              : html`<p class="muted">No app-server state reported yet.</p>`}
          </div>
        </aside>
      </section>
    `;
  }

  private hostSessionRow(session: HostSessionSummary) {
    const attachedThreadId = session.attached_thread_id;
    const instance = primaryAppServerInstanceForConnector(this.data, session.connector_id);
    return html`
      <article
        class=${attachedThreadId ? "session-row clickable" : "session-row"}
        @click=${() => {
          if (attachedThreadId) this.openThread(attachedThreadId);
        }}
      >
        <div>
          <strong>${session.title}</strong>
          <code class="session-id" title=${session.session_id}>${session.session_id}</code>
          <span>${session.hostname} · ${session.cwd ?? "Unknown cwd"}</span>
        </div>
        <span class="chip ${session.title_source}">${titleSourceLabel(session.title_source)}</span>
        ${instance
          ? html`<span class="chip ${instance.state}" title=${instanceTooltip(instance, this.clockNow)}>
              ${appServerInstanceStateLabel(instance.state)}
            </span>`
          : session.app_server_present
            ? html`<span class="chip waiting_for_upload">App server</span>`
            : nothing}
        ${attachedThreadId
          ? html`
              <span class="chip realtime">Attached</span>
              <button
                type="button"
                @click=${(event: Event) => {
                  event.stopPropagation();
                  void this.detachSession(session);
                }}
              >
                Detach
              </button>
            `
          : html`
              <button
                type="button"
                @click=${(event: Event) => {
                  event.stopPropagation();
                  void this.attachSession(session);
                }}
              >
                Attach
              </button>
            `}
      </article>
    `;
  }

  private appServerInstanceCard(instance: AppServerInstanceSummary, density: "full" | "compact") {
    const connector = this.data!.connectors.find((item) => item.id === instance.connector_id);
    const detail = instance.last_error ?? instance.status_summary;
    return html`
      <article class=${`instance-card ${density}`}>
        <header>
          <div>
            <strong>${connector?.name ?? instance.connector_id}</strong>
            <span>${connector?.hostname ?? "Unknown host"}</span>
          </div>
          <span class="chip ${instance.state}">${appServerInstanceStateLabel(instance.state)}</span>
        </header>
        <dl class="instance-facts">
          <div><dt>Scope</dt><dd>${formatMode(instance.scope)}</dd></div>
          <div><dt>Endpoint</dt><dd>${formatMode(instance.endpoint_type)}</dd></div>
          <div><dt>Turns</dt><dd>${instance.active_turn_count}</dd></div>
          ${density === "full" ? html`<div><dt>Generation</dt><dd>${instance.generation}</dd></div>` : nothing}
          <div>
            <dt>Changed</dt>
            <dd title=${formatAbsoluteIso(instance.state_changed_at)}>
              ${formatRelativeIso(instance.state_changed_at, this.clockNow)}
            </dd>
          </div>
          <div>
            <dt>Seen</dt>
            <dd title=${formatAbsoluteIso(instance.last_seen_at)}>${formatRelativeIso(instance.last_seen_at, this.clockNow)}</dd>
          </div>
        </dl>
        ${density === "full"
          ? html`
              <p class="instance-key"><code>${instance.instance_key}</code></p>
              ${detail ? html`<p class="instance-summary">${detail}</p>` : nothing}
            `
          : detail
            ? html`<p class="instance-summary">${detail}</p>`
            : nothing}
      </article>
    `;
  }

  private renderBudgetBoard() {
    const budget = this.data!.budget;
    return html`
      <section class="page-grid budget-grid">
        <section class="panel primary">
          <div class="section-heading">
            <h2>Cost posture</h2>
            <span class="chip ${budget.state}">${budget.state.replace("_", " ")}</span>
          </div>
          <div class="budget-bars">
            ${budgetBar("4-hour window", budget.four_hour_used_pct)}
            ${budgetBar("Daily budget", budget.daily_used_pct)}
            ${budgetBar("Burst window", budget.burst_used_pct)}
          </div>
        </section>
        <aside class="panel">
          <div class="section-heading">
            <h2>Reliability</h2>
            <span>P0/P1 intact</span>
          </div>
          <dl class="facts">
            <div><dt>Delayed events</dt><dd>${budget.delayed_event_count}</dd></div>
            <div><dt>Compacted events</dt><dd>${budget.compacted_event_count}</dd></div>
            <div><dt>Local spool</dt><dd>${formatBytes(budget.local_spool_bytes)}</dd></div>
          </dl>
        </aside>
      </section>
    `;
  }

  private readonly submitCommand = async (): Promise<void> => {
    const thread = this.selectedThread();
    if (!thread) {
      this.commandState = "failed";
      this.actionError = "No thread selected";
      return;
    }

    const task = this.taskForThread(thread.id);
    this.ensureCommandMode();
    this.commandState = "submitting";
    this.actionError = undefined;
    this.actionNotice = undefined;
    try {
      const response = await createCommand({
        workspace_id: thread.workspace_id,
        thread_id: thread.id,
        task_id: task?.id,
        type: commandTypeForMode(this.commandMode),
        execution_mode: commandExecutionModeForRequest(this.commandMode),
        prompt: this.commandPrompt
      });
      this.lastCommandId = response.command.id;
      this.upsertCommand(response.command);
      this.commandState = "accepted";
      await this.load();
    } catch (error) {
      this.commandState = "failed";
      this.actionError = actionErrorMessage("Command failed", error);
    }
  };

  private renderCreateThreadForm(layout: "compact" | "stacked", selectedThreadId?: string) {
    const workspaceId = localThreadWorkspaceId(this.data, selectedThreadId);
    const connectors = localThreadConnectors(this.data, workspaceId);
    const selectedConnectorId = localThreadConnectorId(this.data, workspaceId, this.newThreadConnectorId) ?? "";
    const canCreate = Boolean(workspaceId && connectors.length > 0);
    return html`
      <form class=${`create-thread-form ${layout}`} @submit=${this.submitLocalThreadCreate}>
        <input type="hidden" name="workspace_id" .value=${workspaceId ?? ""} />
        <input
          aria-label="New thread title"
          .value=${this.newThreadTitle}
          ?disabled=${this.newThreadState === "creating"}
          @input=${(event: InputEvent) => {
            this.newThreadTitle = (event.target as HTMLInputElement).value;
          }}
        />
        <select
          aria-label="Connector"
          .value=${selectedConnectorId}
          ?disabled=${this.newThreadState === "creating" || connectors.length === 0}
          @change=${(event: Event) => {
            this.newThreadConnectorId = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="">Auto connector</option>
          ${connectors.map(
            (connector) => html`<option value=${connector.id}>${connector.name} · ${connector.hostname}</option>`
          )}
        </select>
        <button
          type="submit"
          class="primary-action"
          ?disabled=${this.newThreadState === "creating" || !canCreate}
        >
          ${this.newThreadState === "creating" ? "Creating..." : "New local thread"}
        </button>
        ${!canCreate
          ? html`<p class="form-hint">${MANAGED_APP_SERVER_UNAVAILABLE}</p>`
          : nothing}
      </form>
    `;
  }

  private readonly submitLocalThreadCreate = async (event: Event): Promise<void> => {
    event.preventDefault();
    this.actionNotice = undefined;
    const form = event.currentTarget as HTMLFormElement;
    const workspaceId = String(new FormData(form).get("workspace_id") ?? "");
    if (!workspaceId) {
      this.newThreadState = "failed";
      this.actionError = "No workspace is available for local thread creation";
      return;
    }
    if (localThreadConnectors(this.data, workspaceId).length === 0) {
      this.newThreadState = "failed";
      this.actionError = `${MANAGED_APP_SERVER_UNAVAILABLE} Local thread creation requires app-server thread capability.`;
      return;
    }

    const title = this.newThreadTitle.trim() || "New Codex thread";
    const connectorId = localThreadConnectorId(this.data, workspaceId, this.newThreadConnectorId);
    this.newThreadState = "creating";
    this.actionError = undefined;
    this.actionNotice = undefined;
    let response: CreateLocalThreadResponse;
    try {
      response = await createLocalThread({
        workspace_id: workspaceId,
        title,
        connector_id: connectorId
      });
    } catch (error) {
      this.newThreadState = "failed";
      this.actionError = actionErrorMessage("Thread creation failed", error);
      return;
    }

    this.mergeAttachedSession(response);
    this.newThreadState = "idle";
    this.newThreadTitle = "New Codex thread";
    this.openThread(response.thread.id);
    try {
      await this.load();
    } catch (error) {
      this.actionError = actionErrorMessage("Thread refresh failed", error);
    }
  };

  private async toggleTaskArchive(task: TaskSummary): Promise<void> {
    const action = task.archived_at ? "Unarchive" : "Archive";
    this.actionError = undefined;
    this.actionNotice = undefined;
    try {
      const response = task.archived_at
        ? await unarchiveTask(task.id)
        : await archiveTask(task.id);
      this.mergeArchivedTask(response.task);
      this.actionError = archiveSyncWarning(action, response);
      this.actionNotice = archiveSyncNotice(action, response);
      await this.load();
    } catch (error) {
      this.actionError = actionErrorMessage(`${action} failed`, error);
    }
  }

  private async attachSession(session: HostSessionSummary): Promise<void> {
    this.actionError = undefined;
    this.actionNotice = undefined;
    try {
      const response = await attachHostSession(session.session_id, { connector_id: session.connector_id });
      this.mergeAttachedSession(response);
      if (response.backfill?.error) {
        this.actionError = `Attached, but history backfill failed: ${response.backfill.error}`;
      } else {
        this.actionNotice = historyBackfillNotice(response.backfill);
      }
      this.openThread(response.thread.id);
    } catch (error) {
      this.actionError = actionErrorMessage("Attach failed", error);
    }
  }

  private async detachSession(session: HostSessionSummary): Promise<void> {
    this.actionError = undefined;
    this.actionNotice = undefined;
    try {
      const response = await detachHostSession(session.session_id, { connector_id: session.connector_id });
      this.mergeDetachedSession(response);
      await this.load();
    } catch (error) {
      this.actionError = actionErrorMessage("Detach failed", error);
    }
  }

  private readonly refreshHostSessionInventory = async (): Promise<void> => {
    this.actionError = undefined;
    this.actionNotice = undefined;
    this.hostSessionsRefreshState = "refreshing";
    this.hostSessionsRefreshSummary = undefined;
    try {
      const response = await refreshHostSessions();
      this.hostSessionsRefreshSummary = refreshSummary(response.dispatched_to);
      await this.load();
      window.setTimeout(() => void this.load(), 1_200);
      window.setTimeout(() => void this.load(), 2_500);
      this.hostSessionsRefreshState = "idle";
    } catch (error) {
      this.hostSessionsRefreshState = "failed";
      this.actionError = actionErrorMessage("Host session refresh failed", error);
      await this.load().catch(() => undefined);
    }
  };

  private mergeAttachedSession(response: Awaited<ReturnType<typeof attachHostSession>>): void {
    if (!this.data) return;
    this.data = {
      ...this.data,
      host_sessions: [
        response.host_session,
        ...this.data.host_sessions.filter((item) => item.id !== response.host_session.id)
      ],
      tasks: [
        response.task,
        ...this.data.tasks.filter((item) => item.id !== response.task.id)
      ],
      threads: [
        response.thread,
        ...this.data.threads.filter((item) => item.id !== response.thread.id)
      ],
      events: [
        ...(response.events ?? []),
        ...this.data.events.filter(
          (item) => !(response.events ?? []).some((event) => event.id === item.id)
        )
      ]
    };
  }

  private mergeDetachedSession(response: Awaited<ReturnType<typeof detachHostSession>>): void {
    if (!this.data) return;
    this.data = {
      ...this.data,
      host_sessions: [
        response.host_session,
        ...this.data.host_sessions.filter((item) => item.id !== response.host_session.id)
      ]
    };
  }

  private mergeArchivedTask(task: TaskSummary): void {
    if (!this.data) return;
    this.data = {
      ...this.data,
      tasks: [
        task,
        ...this.data.tasks.filter((item) => item.id !== task.id)
      ],
      threads: this.data.threads.map((thread) =>
        thread.id === task.thread_id
          ? {
              ...thread,
              state: task.archived_at ? "archived" : task.state === "running" ? "active" : "idle",
              updated_at: task.updated_at
            }
          : thread
      )
    };
  }

  private openThread(threadId: string): void {
    this.selectedThreadId = threadId;
    this.ensureCommandMode();
    window.location.hash = `thread-centre?thread=${encodeURIComponent(threadId)}`;
    void this.loadSelectedThreadEvents().catch((error) => {
      this.actionError = actionErrorMessage("Thread events refresh failed", error);
    });
  }

  private selectedThread(): ThreadSummary | undefined {
    if (!this.data) return undefined;
    return this.data.threads.find((thread) => thread.id === this.selectedThreadId) ?? this.activeThreads()[0] ?? this.data.threads[0];
  }

  private ensureSelectedThread(): void {
    if (!this.data || this.view !== "thread-centre") return;
    const selected = this.selectedThread();
    this.selectedThreadId = selected?.id;
    this.ensureCommandMode();
  }

  private activeThreads(): ThreadSummary[] {
    if (!this.data) return [];
    return this.data.threads.filter((thread) => thread.state !== "archived");
  }

  private taskForThread(threadId: string): TaskSummary | undefined {
    return this.data?.tasks.find((task) => task.thread_id === threadId);
  }

  private isActiveAttachedHostSession(session: HostSessionSummary): boolean {
    if (!session.attached_thread_id) return false;
    const thread = this.data?.threads.find((item) => item.id === session.attached_thread_id);
    if (thread?.state === "archived") return false;
    const task = session.attached_task_id
      ? this.data?.tasks.find((item) => item.id === session.attached_task_id)
      : undefined;
    return !task?.archived_at;
  }

  private hostSessionsLastSyncedAt(): string | undefined {
    const candidates = [
      this.hostSessionsRealtimeSyncedAt,
      ...(this.data?.host_session_syncs.map((sync) => sync.synced_at).filter(Boolean) ?? [])
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    return candidates.sort().at(-1);
  }

  private appServerInstancesForDisplay(): AppServerInstanceSummary[] {
    if (!this.data) return [];
    const byKnownConnector = this.data.connectors.flatMap((connector) =>
      appServerInstancesForConnector(this.data, connector.id)
    );
    const knownIds = new Set(byKnownConnector.map((instance) => instance.id));
    const unknownConnectorInstances = this.data.app_server_instances
      .filter((instance) => !knownIds.has(instance.id))
      .sort((left, right) => {
        const connectorDelta = left.connector_id.localeCompare(right.connector_id);
        if (connectorDelta !== 0) return connectorDelta;
        return left.instance_key.localeCompare(right.instance_key);
      });
    return [...byKnownConnector, ...unknownConnectorInstances];
  }

  private threadListItem(thread: ThreadSummary) {
    const task = this.taskForThread(thread.id);
    return html`
      <button
        type="button"
        class=${this.selectedThreadId === thread.id ? "thread-list-item active" : "thread-list-item"}
        @click=${() => this.openThread(thread.id)}
      >
        <strong>${thread.title}</strong>
        <span>${task?.state ?? thread.state} · seq ${thread.last_seq}</span>
      </button>
    `;
  }

  private eventsForThread(threadId: string): ThreadEvent[] {
    return this.data!.events
      .filter((event) => event.thread_id === threadId)
      .sort((left, right) => {
        if (left.seq !== right.seq) return right.seq - left.seq;
        return right.created_at.localeCompare(left.created_at);
      });
  }

  private async loadSelectedThreadEvents(): Promise<void> {
    if (!this.data) return;
    const thread = this.selectedThread();
    if (!thread) return;
    const response = await loadThreadEvents(thread.id);
    this.mergeThreadEvents(response.events);
    if (this.actionError?.startsWith("Thread events refresh failed:")) {
      this.actionError = undefined;
    }
  }

  private mergeThreadEvents(incoming: ThreadEvent[]): void {
    if (!this.data || incoming.length === 0) return;
    const incomingIds = new Set(incoming.map((event) => event.id));
    this.data = {
      ...this.data,
      events: [
        ...incoming,
        ...this.data.events.filter((event) => !incomingIds.has(event.id))
      ]
    };
  }

  private commandModeButton(mode: CommandExecutionMode) {
    return html`
      <button
        type="button"
        class=${this.commandMode === mode ? "active" : ""}
        ?disabled=${this.commandState === "submitting"}
        @click=${() => {
          this.commandMode = mode;
        }}
      >
        ${commandModeLabel(mode)}
      </button>
    `;
  }

  private ensureCommandMode(): void {
    const thread = this.selectedThread();
    const nextMode = normaliseCommandMode(this.commandMode, this.data, thread?.id, {
      showCliFallback: SHOW_CODEX_CLI_FALLBACK
    });
    if (nextMode !== this.commandMode) {
      this.commandMode = nextMode;
    }
  }

  private connectRealtime(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    window.clearTimeout(this.reconnectTimer);
    this.realtimeState = "connecting";

    try {
      const socket = new WebSocket(browserSocketUrl());
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        this.realtimeState = "live";
        this.stopFallbackPolling();
      });
      socket.addEventListener("message", (event) => this.handleRealtimeMessage(event));
      socket.addEventListener("close", () => this.handleRealtimeDisconnect(socket));
      socket.addEventListener("error", () => this.handleRealtimeDisconnect(socket));
    } catch {
      this.startFallbackPolling();
      this.scheduleRealtimeReconnect();
    }
  }

  private disconnectRealtime(): void {
    window.clearTimeout(this.reconnectTimer);
    this.stopFallbackPolling();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private handleRealtimeDisconnect(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.startFallbackPolling();
    this.scheduleRealtimeReconnect();
  }

  private handleRealtimeMessage(event: MessageEvent): void {
    const envelope = parseEnvelope(event.data);
    if (!envelope) return;
    if (envelope.kind === "thread.event" && isRealtimeThreadEventPayload(envelope.payload)) {
      this.applyThreadEvent(envelope.payload.event);
    }
    if (envelope.kind === "host_sessions.updated" && isRealtimeHostSessionsPayload(envelope.payload)) {
      this.applyHostSessions(envelope.payload);
    }
    if (envelope.kind === "connectors.updated" && isRealtimeConnectorsPayload(envelope.payload)) {
      this.applyConnectors(envelope.payload);
    }
    if (
      envelope.kind === "app_server_instances.updated" &&
      isRealtimeAppServerInstancesPayload(envelope.payload)
    ) {
      this.applyAppServerInstances(envelope.payload);
    }
  }

  private scheduleRealtimeReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connectRealtime(), SOCKET_RECONNECT_MS);
  }

  private startFallbackPolling(): void {
    this.realtimeState = "polling";
    if (this.pollTimer !== undefined) return;
    void this.load();
    this.pollTimer = window.setInterval(() => void this.load(), FALLBACK_POLL_MS);
  }

  private stopFallbackPolling(): void {
    if (this.pollTimer === undefined) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private applyThreadEvent(event: ThreadEvent): void {
    if (!this.data) return;
    const events = this.data.events.filter((item) => item.id !== event.id);
    events.push(event);
    this.data = {
      ...this.data,
      events,
      running_commands: this.updateCommandsForEvent(this.data.running_commands, event),
      threads: this.updateThreadsForEvent(this.data.threads, event),
      tasks: this.updateTasksForEvent(this.data.tasks, event)
    };
  }

  private applyHostSessions(payload: HostSessionsUpdatePayload): void {
    if (!this.data) return;
    if (payload.synced_at) {
      this.hostSessionsRealtimeSyncedAt = newerIso(this.hostSessionsRealtimeSyncedAt, payload.synced_at);
      this.hostSessionsRefreshState = "idle";
    }
    const hostSessions = payload.host_sessions;
    const incomingIds = new Set(hostSessions.map((session) => session.id));
    this.data = {
      ...this.data,
      host_sessions: [
        ...hostSessions,
        ...this.data.host_sessions.filter((session) => {
          if (payload.snapshot && payload.connector_id && session.connector_id === payload.connector_id) {
            return false;
          }
          return !incomingIds.has(session.id);
        })
      ]
    };
    this.ensureCommandMode();
  }

  private applyConnectors(payload: ConnectorsUpdatePayload): void {
    if (!this.data) return;
    const knownIds = new Set(this.data.connectors.map((connector) => connector.id));
    const hasUnknownConnector = payload.connectors.some((connector) => !knownIds.has(connector.id));
    this.data = {
      ...this.data,
      connectors: mergeConnectorSummaries(this.data.connectors, payload.connectors)
    };
    this.ensureCommandMode();
    if (hasUnknownConnector) {
      void this.load();
    }
  }

  private applyAppServerInstances(payload: AppServerInstancesUpdatePayload): void {
    if (!this.data) return;
    this.data = {
      ...this.data,
      app_server_instances: mergeAppServerInstances(
        this.data.app_server_instances,
        payload.app_server_instances,
        { snapshotConnectorId: payload.snapshot ? payload.connector_id : undefined }
      )
    };
  }

  private upsertCommand(command: CommandSummary): void {
    if (!this.data) return;
    this.data = {
      ...this.data,
      running_commands: [
        command,
        ...this.data.running_commands.filter((item) => item.id !== command.id)
      ]
    };
  }

  private updateCommandsForEvent(commands: CommandSummary[], event: ThreadEvent): CommandSummary[] {
    if (!event.command_id) return commands;
    const state = commandStateForEvent(event.kind);
    if (!state) return commands;

    return commands.map((command) =>
      command.id === event.command_id
        ? { ...command, state, updated_at: event.created_at }
        : command
    );
  }

  private updateThreadsForEvent(threads: ThreadSummary[], event: ThreadEvent): ThreadSummary[] {
    return threads.map((thread) =>
      thread.id === event.thread_id
        ? { ...thread, last_seq: Math.max(thread.last_seq, event.seq), updated_at: event.created_at }
        : thread
    );
  }

  private updateTasksForEvent(tasks: TaskSummary[], event: ThreadEvent): TaskSummary[] {
    if (!event.command_id) return tasks;
    const command = this.data?.running_commands.find((item) => item.id === event.command_id);
    if (!command?.task_id) return tasks;
    const state = taskStateForEvent(event.kind);
    if (!state) return tasks;

    return tasks.map((task) =>
      task.id === command.task_id ? { ...task, state, updated_at: event.created_at } : task
    );
  }
}

function viewFromHash(): View {
  const value = hashPath();
  if (value === "task-board" || value === "host-sessions" || value === "thread-centre" || value === "budget-board") {
    return value;
  }
  return "operations-map";
}

function threadIdFromHash(): string | undefined {
  const query = window.location.hash.split("?")[1];
  if (!query) return undefined;
  return new URLSearchParams(query).get("thread") ?? undefined;
}

function hashPath(): string {
  return window.location.hash.replace("#", "").split("?")[0] ?? "";
}

function viewTitle(view: View): string {
  return {
    "operations-map": "Operations Map",
    "task-board": "Operations Task Board",
    "host-sessions": "Host Sessions",
    "thread-centre": "Thread Command Centre",
    "budget-board": "Budget Reliability Board"
  }[view];
}

function viewQuestion(view: View): string {
  return {
    "operations-map": "Is the fleet healthy, and where should I look next?",
    "task-board": "What work is moving, blocked, waiting, or done?",
    "host-sessions": "Which local Codex sessions are not attached to Chaop yet?",
    "thread-centre": "What is happening inside this one task right now?",
    "budget-board": "What is the current cost and reliability posture?"
  }[view];
}

function formatMode(mode: string): string {
  return mode.replaceAll("_", " ");
}

function formatCommandType(type: CommandSummary["type"]): string {
  return type === "codex" ? "Codex" : "Placeholder";
}

function formatCommandExecution(command: CommandSummary): string {
  if (command.execution_mode) {
    return commandModeLabel(command.execution_mode);
  }
  return formatCommandType(command.type);
}

function realtimeLabel(state: RealtimeState): string {
  return {
    connecting: "Connecting",
    live: "Live",
    polling: "Polling 10s"
  }[state];
}

function titleSourceLabel(source: HostSessionSummary["title_source"]): string {
  return {
    metadata: "Metadata",
    app_server: "App server",
    history: "History",
    fallback: "Fallback"
  }[source];
}

function instanceTooltip(instance: AppServerInstanceSummary, nowMs: number): string {
  const changed = formatRelativeIso(instance.state_changed_at, nowMs);
  const seen = formatRelativeIso(instance.last_seen_at, nowMs);
  return `${formatMode(instance.scope)} ${formatMode(instance.endpoint_type)} app-server, ${instance.active_turn_count} active turns, changed ${changed}, seen ${seen}`;
}

function refreshSummary(dispatchedTo: number): string {
  if (dispatchedTo === 0) return "No online connector accepted the refresh request.";
  if (dispatchedTo === 1) return "Refresh requested from 1 online connector.";
  return `Refresh requested from ${dispatchedTo} online connectors.`;
}

function formatSyncStatus(iso: string | undefined, nowMs: number): string {
  if (!iso) return "Last synced: never";
  const syncedAt = new Date(iso);
  if (Number.isNaN(syncedAt.getTime())) return "Last synced: unknown";
  const timestamp = syncedAt.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium"
  });
  return `Last synced: ${timestamp} (${formatRelativeIso(iso, nowMs)})`;
}

function formatRelativeIso(iso: string, nowMs: number): string {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "unknown";
  const age = formatAge(nowMs - timestamp);
  return age === "just now" ? age : `${age} ago`;
}

function formatAbsoluteIso(iso: string): string {
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime())) return "Unknown";
  return timestamp.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium"
  });
}

function formatAge(ageMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(ageMs / 1000));
  if (totalSeconds < 5) return "just now";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}

function newerIso(current: string | undefined, incoming: string): string {
  return current && current > incoming ? current : incoming;
}

function actionErrorMessage(prefix: string, error: unknown): string {
  if (error instanceof ApiError) {
    return `${prefix}: ${cleanApiErrorMessage(error.message)}`;
  }
  if (error instanceof Error && error.message) {
    return `${prefix}: ${error.message}`;
  }
  return prefix;
}

function cleanApiErrorMessage(message: string): string {
  return message.replace(/^(Request failed|Command creation failed|Bootstrap failed):\s*/, "");
}

function commandStateForEvent(kind: ThreadEvent["kind"]): CommandSummary["state"] | undefined {
  if (kind === "command.started") return "running";
  if (kind === "command.finished") return "succeeded";
  if (kind === "command.failed") return "failed";
  return undefined;
}

function taskStateForEvent(kind: ThreadEvent["kind"]): TaskSummary["state"] | undefined {
  if (kind === "command.started") return "running";
  if (kind === "command.finished") return "done";
  if (kind === "command.failed") return "failed";
  return undefined;
}

function parseEnvelope(value: unknown): { kind?: string; payload?: unknown } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRealtimeThreadEventPayload(value: unknown): value is RealtimeThreadEventPayload {
  if (typeof value !== "object" || value === null) return false;
  const event = (value as { event?: unknown }).event;
  if (typeof event !== "object" || event === null) return false;
  const record = event as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.thread_id === "string" &&
    typeof record.seq === "number" &&
    typeof record.kind === "string" &&
    typeof record.priority === "string" &&
    typeof record.summary === "string" &&
    typeof record.created_at === "string"
  );
}

function isRealtimeHostSessionsPayload(value: unknown): value is RealtimeHostSessionsPayload {
  if (typeof value !== "object" || value === null) return false;
  const hostSessions = (value as { host_sessions?: unknown }).host_sessions;
  const syncedAt = (value as { synced_at?: unknown }).synced_at;
  const connectorId = (value as { connector_id?: unknown }).connector_id;
  const snapshot = (value as { snapshot?: unknown }).snapshot;
  return (
    Array.isArray(hostSessions) &&
    (syncedAt === undefined || typeof syncedAt === "string") &&
    (connectorId === undefined || typeof connectorId === "string") &&
    (snapshot === undefined || typeof snapshot === "boolean")
  );
}

function isRealtimeConnectorsPayload(value: unknown): value is RealtimeConnectorsPayload {
  if (typeof value !== "object" || value === null) return false;
  const connectors = (value as { connectors?: unknown }).connectors;
  const syncedAt = (value as { synced_at?: unknown }).synced_at;
  return (
    Array.isArray(connectors) &&
    connectors.every((connector) => {
      if (typeof connector !== "object" || connector === null) return false;
      const record = connector as Record<string, unknown>;
      return (
        typeof record.id === "string" &&
        Array.isArray(record.capabilities) &&
        record.capabilities.every((item) => typeof item === "string")
      );
    }) &&
    (syncedAt === undefined || typeof syncedAt === "string")
  );
}

function isRealtimeAppServerInstancesPayload(value: unknown): value is RealtimeAppServerInstancesPayload {
  if (typeof value !== "object" || value === null) return false;
  const instances = (value as { app_server_instances?: unknown }).app_server_instances;
  const syncedAt = (value as { synced_at?: unknown }).synced_at;
  const connectorId = (value as { connector_id?: unknown }).connector_id;
  const snapshot = (value as { snapshot?: unknown }).snapshot;
  return (
    Array.isArray(instances) &&
    instances.every((instance) => {
      if (typeof instance !== "object" || instance === null) return false;
      const record = instance as Record<string, unknown>;
      return (
        typeof record.id === "string" &&
        typeof record.connector_id === "string" &&
        typeof record.instance_key === "string" &&
        typeof record.state === "string" &&
        typeof record.updated_at === "string"
      );
    }) &&
    (syncedAt === undefined || typeof syncedAt === "string") &&
    (connectorId === undefined || typeof connectorId === "string") &&
    (snapshot === undefined || typeof snapshot === "boolean")
  );
}

function budgetBar(label: string, value: number) {
  return html`
    <div class="budget-bar">
      <div><span>${label}</span><strong>${value}%</strong></div>
      <meter min="0" max="100" value=${value}></meter>
    </div>
  `;
}

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  return `${mib.toFixed(0)} MiB`;
}
