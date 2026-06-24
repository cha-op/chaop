import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  groupTasksByState,
  TASK_STATE_LABELS,
  type AppServerInstanceSummary,
  type AppServerInstancesUpdatePayload,
  type BootstrapPayload,
  type BudgetConstraint,
  type BudgetSummary,
  type CommandSummary,
  type ConnectorSummary,
  type ConnectorsUpdatePayload,
  type CreateLocalThreadResponse,
  type DogfoodSafetyAction,
  type HostSessionsUpdatePayload,
  type HostSessionSummary,
  type RefreshHostSessionsResponse,
  type TaskState,
  type TaskSummary,
  type ThreadEvent,
  type ThreadSummary
} from "@chaop/protocol";
import {
  ApiError,
  archiveTask,
  attachHostSession,
  bootstrapBudgetSamples as requestBudgetBootstrap,
  browserSocketUrl,
  createCommand,
  createLocalThread,
  detachHostSession,
  loadBootstrap,
  loadSafetyPosture,
  loadUsageSummary,
  loadThreadEvents,
  pauseDogfoodSafety,
  refreshHostSessions,
  resumeDogfoodSafety,
  unarchiveTask
} from "./api.js";
import {
  appServerInstanceForHostSession,
  appServerInstancePlacementLabel,
  appServerInstanceStateLabel,
  appServerInstancesForDisplay,
  archiveSyncNotice,
  archiveSyncWarning,
  budgetPctLabel,
  budgetSourceLabel,
  codexCliFallbackAvailable,
  commandExecutionModeForRequest,
  commandModeLabel,
  commandTypeForMode,
  defaultCommandMode,
  historyBackfillNotice,
  localThreadConnectorId,
  localThreadConnectors,
  localThreadWorkspaceId,
  MANAGED_APP_SERVER_UNAVAILABLE,
  managedAppServerCommandAvailable,
  mergeBootstrapPayload,
  mergeAppServerInstances,
  mergeConnectorSummaries,
  mergeHostSessions,
  normaliseCommandMode,
  safetyActionBlocked,
  safetyActionReason,
  threadTurnsForDisplay,
  type CommandExecutionMode,
  type ThreadTurnSummary
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
const BUDGET_REFRESH_MS = 60_000;
const HOST_SESSIONS_AUTO_REFRESH_MS = 60_000;
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

  private commandModeExplicit = false;

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
  private hostSessionsAutoRefresh = false;

  @state()
  private safetyControlState: "idle" | "updating" | "failed" = "idle";

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

  private budgetTimer: number | undefined;

  private hostSessionsAutoTimer: number | undefined;

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
    this.stopBudgetPolling();
    this.stopHostSessionsAutoRefresh();
    this.hostSessionsAutoRefresh = false;
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
          ${this.renderSafetyGate()}
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
    const nextView = viewFromHash();
    if (this.view === "host-sessions" && nextView !== "host-sessions") {
      this.hostSessionsAutoRefresh = false;
      this.stopHostSessionsAutoRefresh();
    }
    this.view = nextView;
    const nextThreadId = threadIdFromHash();
    const threadChanged = nextThreadId !== this.selectedThreadId;
    if (threadChanged) {
      this.commandModeExplicit = false;
      this.resetThreadCommandState();
    }
    this.selectedThreadId = nextThreadId;
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
    const safety = this.data!.safety;
    const bottleneck = budgetBottleneckConstraint(budget);
    const budgetChipState = budgetCompactState(budget, bottleneck);
    return html`
      <header class="topbar">
        <div>
          <strong>${viewTitle(this.view)}</strong>
          <span>${viewQuestion(this.view)}</span>
        </div>
        <div class="topbar-status">
          <span class="chip ${this.realtimeState}">${realtimeLabel(this.realtimeState)}</span>
          <span class="chip ${safety.paused ? "hard_limited" : safety.state}">${safetyChipLabel(safety)}</span>
          <span class="chip ${budgetChipState}">${budgetCompactLabel(bottleneck)}</span>
          <span class="identity">${this.data!.user.email}</span>
        </div>
      </header>
    `;
  }

  private renderSafetyGate() {
    const safety = this.data!.safety;
    const blocked = safety.actions.filter((guard) => guard.state === "blocked");
    const bottleneck = safety.bottleneck_constraint;
    return html`
      <section class=${`safety-gate ${safety.paused ? "paused" : safety.state}`}>
        <div>
          <strong>Dogfood safety</strong>
          <span>${safety.summary}</span>
        </div>
        <div class="safety-facts">
          ${bottleneck
            ? html`<span>${bottleneck.label}: ${budgetPctLabel(bottleneck.used_pct)}</span>`
            : html`<span>No sampled bottleneck</span>`}
          <span>${blocked.length} blocked actions</span>
          <button
            type="button"
            class=${safety.paused ? "" : "danger-action"}
            ?disabled=${this.safetyControlState === "updating"}
            @click=${safety.paused ? this.resumeDogfoodSafety : this.pauseDogfoodSafety}
          >
            ${this.safetyControlState === "updating"
              ? "Updating..."
              : safety.paused
                ? "Resume"
                : "Pause writes"}
          </button>
        </div>
      </section>
    `;
  }

  private safetyBlocked(action: DogfoodSafetyAction): boolean {
    return safetyActionBlocked(this.data, action);
  }

  private safetyButtonTitle(action: DogfoodSafetyAction): string {
    return safetyActionReason(this.data, action) ?? "Allowed by dogfood safety gate";
  }

  private guardSafetyAction(action: DogfoodSafetyAction): boolean {
    const reason = safetyActionReason(this.data, action);
    if (!reason) return true;
    this.actionError = reason;
    return false;
  }

  private stopHostSessionsAutoRefreshIfBlocked(): void {
    if (this.hostSessionsAutoRefresh && this.safetyBlocked("host_session_refresh")) {
      this.hostSessionsAutoRefresh = false;
      this.stopHostSessionsAutoRefresh();
    }
  }

  private readonly pauseDogfoodSafety = async (): Promise<void> => {
    this.safetyControlState = "updating";
    this.actionError = undefined;
    this.actionNotice = undefined;
    try {
      const response = await pauseDogfoodSafety({ reason: "Operator emergency pause from Browser" });
      this.mergeSafetyPosture(response.safety);
      this.hostSessionsAutoRefresh = false;
      this.stopHostSessionsAutoRefresh();
      this.actionNotice = "Guarded dogfood actions paused.";
      this.safetyControlState = "idle";
    } catch (error) {
      this.safetyControlState = "failed";
      this.actionError = actionErrorMessage("Safety pause failed", error);
    }
  };

  private readonly resumeDogfoodSafety = async (): Promise<void> => {
    this.safetyControlState = "updating";
    this.actionError = undefined;
    this.actionNotice = undefined;
    try {
      const response = await resumeDogfoodSafety();
      this.mergeSafetyPosture(response.safety);
      this.actionNotice = "Guarded dogfood actions resumed.";
      this.safetyControlState = "idle";
    } catch (error) {
      this.safetyControlState = "failed";
      this.actionError = actionErrorMessage("Safety resume failed", error);
    }
  };

  private renderOperationsMap() {
    const appServerInstances = appServerInstancesForDisplay(this.data);
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
            title=${this.safetyButtonTitle("task_archive")}
            ?disabled=${this.safetyBlocked("task_archive")}
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
    const turns = threadTurnsForDisplay(thread.id, this.data!.running_commands, events);
    const command = (this.lastCommandId
      ? turns.find((turn) => turn.command_id === this.lastCommandId)?.command
      : undefined)
      ?? turns.find((turn) => turn.command)?.command
      ?? this.data!.running_commands.find((item) => item.thread_id === thread.id);

    return html`
      <section class="page-grid thread-grid">
        <section class="panel primary">
          <div class="section-heading">
            <h2>${thread.title}</h2>
            <div class="section-actions">
              ${task
                ? html`
                    <button
                      type="button"
                      title=${this.safetyButtonTitle("task_archive")}
                      ?disabled=${this.safetyBlocked("task_archive")}
                      @click=${() => void this.toggleTaskArchive(task)}
                    >
                      ${task.archived_at ? "Unarchive" : "Archive"}
                    </button>
                  `
                : nothing}
              <span class="chip ${thread.realtime_mode}">${formatMode(thread.realtime_mode)}</span>
            </div>
          </div>
          <label class="command-box">
            <span>Prompt</span>
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
            title=${this.safetyButtonTitle("command_create")}
            ?disabled=${this.commandState === "submitting" || this.commandPrompt.trim().length === 0 || this.safetyBlocked("command_create")}
            @click=${this.submitCommand}
          >
            ${this.commandState === "submitting" ? "Submitting..." : `Send with ${commandModeLabel(this.commandMode)}`}
          </button>
          ${this.commandState === "accepted"
            ? html`<p class="command-status success">
                Prompt accepted${this.lastCommandId ? `: ${this.lastCommandId}` : ""}.
              </p>`
            : nothing}
          ${this.commandState === "failed"
            ? html`<p class="command-status failed">Command request failed.</p>`
            : nothing}
          ${this.renderTurnStream(turns)}
          <div class="timeline event-log">
            <div class="subsection-heading">
              <h3>Raw events</h3>
              <span>${events.length} recorded</span>
            </div>
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

  private renderTurnStream(turns: ThreadTurnSummary[]) {
    return html`
      <section class="turn-stream" aria-label="Thread turns">
        <div class="subsection-heading">
          <h3>Turns</h3>
          <span>${turns.length} ${turns.length === 1 ? "turn" : "turns"}</span>
        </div>
        ${turns.length > 0
          ? turns.map((turn) => this.renderThreadTurn(turn))
          : html`<p class="muted">No turns recorded for this thread yet.</p>`}
      </section>
    `;
  }

  private renderThreadTurn(turn: ThreadTurnSummary) {
    const latestProgress = turn.progress_summaries.slice(-3).reverse();
    return html`
      <article class=${`turn-row ${turn.status}`}>
        <header>
          <div>
            <span>Prompt</span>
            <strong>${turn.prompt ?? "Prompt unavailable from retained command history"}</strong>
          </div>
          <span class=${`chip ${turn.status}`}>${turnStatusLabel(turn.status)}</span>
        </header>
        ${turn.assistant_summary
          ? html`
              <div class="assistant-answer">
                <span>Assistant</span>
                <p>${turn.assistant_summary}</p>
              </div>
            `
          : this.renderPendingTurnBody(turn)}
        ${latestProgress.length > 0
          ? html`
              <ul class="turn-progress">
                ${latestProgress.map((summary) => html`<li>${summary}</li>`)}
              </ul>
            `
          : nothing}
        <footer>
          <span>${turn.command_id}</span>
          <span>${turn.event_count} ${turn.event_count === 1 ? "event" : "events"}</span>
          <span title=${formatAbsoluteIso(turn.updated_at)}>${formatRelativeIso(turn.updated_at, this.clockNow)}</span>
        </footer>
      </article>
    `;
  }

  private renderPendingTurnBody(turn: ThreadTurnSummary) {
    if (turn.status === "failed") {
      return html`
        <div class="assistant-answer failed">
          <span>Failure</span>
          <p>${turn.error_summary ?? "The turn failed before an assistant message was recorded."}</p>
        </div>
      `;
    }
    if (turn.status === "succeeded") {
      return html`
        <div class="assistant-answer empty">
          <span>Assistant</span>
          <p>The turn completed without an assistant message.</p>
        </div>
      `;
    }
    return html`
      <div class="assistant-answer pending">
        <span>Assistant</span>
        <p>${turn.status === "waiting" ? "Waiting for a required action." : "Waiting for the next update."}</p>
      </div>
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
    const appServerInstances = appServerInstancesForDisplay(this.data);

    return html`
      <section class="page-grid sessions-grid">
        <section class="panel primary">
          <div class="section-heading">
            <h2>Unattached sessions</h2>
            <div class="section-actions host-sync-actions">
              <button
                type="button"
                title=${this.safetyButtonTitle("host_session_refresh")}
                ?disabled=${this.hostSessionsRefreshState === "refreshing" || this.safetyBlocked("host_session_refresh")}
                @click=${this.refreshHostSessionInventory}
              >
                ${this.hostSessionsRefreshState === "refreshing" ? "Refreshing..." : "Refresh"}
              </button>
              <label class="sync-toggle" title="Request host inventory at most once per minute while this page is open.">
                <input
                  type="checkbox"
                  .checked=${this.hostSessionsAutoRefresh}
                  ?disabled=${this.safetyBlocked("host_session_refresh")}
                  @change=${this.toggleHostSessionsAutoRefresh}
                />
                Auto 60s
              </label>
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
    const instance = appServerInstanceForHostSession(this.data, session);
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
          ? html`<span class="chip ${instance.state} app-server-health-chip" title=${instanceTooltip(instance, this.clockNow)}>
              ${appServerInstanceStateLabel(instance.state)}
            </span>`
          : session.app_server_present
            ? html`<span class="chip waiting_for_upload app-server-health-chip">App server</span>`
            : nothing}
        ${attachedThreadId
          ? html`
              <span class="chip realtime">Attached</span>
              <button
                type="button"
                title=${this.safetyButtonTitle("host_session_detach")}
                ?disabled=${this.safetyBlocked("host_session_detach")}
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
                title=${this.safetyButtonTitle("host_session_attach")}
                ?disabled=${this.safetyBlocked("host_session_attach")}
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
          <div><dt>Placement</dt><dd>${appServerInstancePlacementLabel(instance)}</dd></div>
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
    const windows = budgetWindows(budget);
    const constraints = budgetConstraints(budget);
    const bottleneck = budgetBottleneckConstraint(budget);
    const newestWindow = newestBudgetWindowUpdatedAt(budget);
    const generatedAt = budget.generated_at ?? this.data!.server_time;
    const windowSampleCount = budget.window_sample_count ?? windows.length;
    const constraintSampleCount = budget.constraint_sample_count ?? constraints.filter((constraint) => constraint.sampled).length;
    return html`
      <section class="page-grid budget-grid">
        <section class="panel primary">
          <div class="section-heading">
            <h2>Cost posture</h2>
            <div class="section-actions">
              <button
                type="button"
                title=${this.safetyButtonTitle("budget_bootstrap")}
                ?disabled=${this.safetyBlocked("budget_bootstrap")}
                @click=${this.bootstrapBudgetSamples}
              >
                Bootstrap
              </button>
              <span class="chip ${budget.state}">${budget.state.replace("_", " ")}</span>
            </div>
          </div>
          <p class="panel-subtle">
            ${budgetSourceLabel(budget)}
            <br>
            Daily Cloudflare rows are current UTC-day analytics; 4h/minute rows are Chaop local schema-model windows, with unopened current windows shown as 0.
          </p>
          ${bottleneck
            ? html`
                <article class="budget-bottleneck">
                  <div>
                    <span>Current bottleneck</span>
                    <strong>${bottleneck.label}</strong>
                  </div>
                  <div>
                    <span>Remaining</span>
                    <strong>${budgetRemainingLabel(bottleneck)}</strong>
                  </div>
                  <small>${bottleneck.detail}</small>
                </article>
              `
            : html`
                <article class="budget-bottleneck missing">
                  <div>
                    <span>Current bottleneck</span>
                    <strong>missing</strong>
                  </div>
                  <small>No sampled hard budget constraint is available yet.</small>
                </article>
              `}
          ${budgetTelemetryTrend(budget)}
          <div class="budget-bars">
            ${constraints.map((constraint) => budgetConstraintBar(constraint))}
          </div>
          <div class="budget-windows" aria-label="Sampled budget constraints">
            ${constraints.map(
              (constraint) => html`
                <div class=${constraint.sampled ? "" : "missing"}>
                  <span>${constraint.label}</span>
                  <strong>${budgetPctLabel(constraint.used_pct)}</strong>
                  <small title=${constraint.updated_at ? formatAbsoluteIso(constraint.updated_at) : constraint.detail}>
                    ${budgetConstraintDetail(constraint)}
                  </small>
                </div>
              `
            )}
          </div>
          <div class="budget-windows secondary" aria-label="Sampled usage windows">
            ${windows.map(
              (window) => html`
                <div>
                  <span>${budgetWindowLabel(window.window_type)}</span>
                  <strong>${budgetPctLabel(window.used_pct)}</strong>
                  <small title=${formatAbsoluteIso(window.updated_at)}>
                    ${budgetWindowDetail(window)}, updated
                    ${formatRelativeIso(window.updated_at, this.clockNow)}
                  </small>
                </div>
              `
            )}
          </div>
        </section>
        <aside class="panel">
          <div class="section-heading">
            <h2>Reliability</h2>
            <span>${budgetConstraintSampleLabel(constraintSampleCount, constraints.length)}</span>
          </div>
          <dl class="facts">
            <div><dt>Delayed events</dt><dd>${budget.delayed_event_count}</dd></div>
            <div><dt>Compacted events</dt><dd>${budget.compacted_event_count}</dd></div>
            <div><dt>Local spool</dt><dd>${formatBytes(budget.local_spool_bytes)}</dd></div>
            <div><dt>Usage windows</dt><dd>${windowSampleCount}</dd></div>
            <div>
              <dt>Generated</dt>
              <dd title=${formatAbsoluteIso(generatedAt)}>${formatRelativeIso(generatedAt, this.clockNow)}</dd>
            </div>
            <div>
              <dt>Current window</dt>
              <dd title=${newestWindow ? formatAbsoluteIso(newestWindow) : "No usage window"}>
                ${newestWindow ? formatRelativeIso(newestWindow, this.clockNow) : "none"}
              </dd>
            </div>
            ${budget.d1_write_model
              ? html`
                  <div><dt>D1 rows/event</dt><dd>${budget.d1_write_model.budgeted_rows_written_per_event}</dd></div>
                  <div><dt>D1 free rows/day</dt><dd>${budget.d1_write_model.free_rows_written_per_day.toLocaleString("en-GB")}</dd></div>
                  <div><dt>Command event</dt><dd>${budget.d1_write_model.command_lifecycle_with_task_rows_written} rows</dd></div>
                  <div><dt>Backfill floor</dt><dd>${budget.d1_write_model.backfill_rows_written_per_event} rows/event</dd></div>
                `
              : nothing}
          </dl>
          ${budgetD1ActivitySignals(budget)}
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
    if (!this.guardSafetyAction("command_create")) {
      this.commandState = "failed";
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
      this.upsertCommand(response.command);
      if (this.selectedThread()?.id === thread.id) {
        this.lastCommandId = response.command.id;
        this.commandState = "accepted";
      }
      await this.load();
    } catch (error) {
      this.mergeSafetyPostureFromError(error);
      if (this.selectedThread()?.id === thread.id) {
        this.commandState = "failed";
        this.actionError = actionErrorMessage("Command failed", error);
      }
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
          title=${this.safetyButtonTitle("local_thread_create")}
          ?disabled=${this.newThreadState === "creating" || !canCreate || this.safetyBlocked("local_thread_create")}
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
    if (!this.guardSafetyAction("local_thread_create")) {
      this.newThreadState = "failed";
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
      this.mergeSafetyPostureFromError(error);
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
    if (!this.guardSafetyAction("task_archive")) return;
    try {
      const response = task.archived_at
        ? await unarchiveTask(task.id)
        : await archiveTask(task.id);
      this.mergeArchivedTask(response.task);
      this.actionError = archiveSyncWarning(action, response);
      this.actionNotice = archiveSyncNotice(action, response);
      await this.load();
    } catch (error) {
      this.mergeSafetyPostureFromError(error);
      this.actionError = actionErrorMessage(`${action} failed`, error);
    }
  }

  private async attachSession(session: HostSessionSummary): Promise<void> {
    this.actionError = undefined;
    this.actionNotice = undefined;
    if (!this.guardSafetyAction("host_session_attach")) return;
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
      this.mergeSafetyPostureFromError(error);
      this.actionError = actionErrorMessage("Attach failed", error);
    }
  }

  private async detachSession(session: HostSessionSummary): Promise<void> {
    this.actionError = undefined;
    this.actionNotice = undefined;
    if (!this.guardSafetyAction("host_session_detach")) return;
    try {
      const response = await detachHostSession(session.session_id, { connector_id: session.connector_id });
      this.mergeDetachedSession(response);
      await this.load();
    } catch (error) {
      this.mergeSafetyPostureFromError(error);
      this.actionError = actionErrorMessage("Detach failed", error);
    }
  }

  private readonly refreshHostSessionInventory = async (): Promise<void> => {
    await this.requestHostSessionInventory();
  };

  private readonly toggleHostSessionsAutoRefresh = (event: Event): void => {
    const enabled = (event.target as HTMLInputElement).checked;
    if (enabled && !this.guardSafetyAction("host_session_refresh")) {
      (event.target as HTMLInputElement).checked = false;
      this.hostSessionsAutoRefresh = false;
      this.stopHostSessionsAutoRefresh();
      return;
    }
    this.hostSessionsAutoRefresh = enabled;
    if (enabled) {
      this.startHostSessionsAutoRefresh();
      void this.requestHostSessionInventory();
    } else {
      this.stopHostSessionsAutoRefresh();
    }
  };

  private startHostSessionsAutoRefresh(): void {
    this.stopHostSessionsAutoRefresh();
    this.hostSessionsAutoTimer = window.setInterval(() => {
      if (this.view !== "host-sessions" || !this.hostSessionsAutoRefresh) {
        this.stopHostSessionsAutoRefresh();
        this.hostSessionsAutoRefresh = false;
        return;
      }
      void this.requestHostSessionInventory();
    }, HOST_SESSIONS_AUTO_REFRESH_MS);
  }

  private stopHostSessionsAutoRefresh(): void {
    if (this.hostSessionsAutoTimer !== undefined) {
      window.clearInterval(this.hostSessionsAutoTimer);
      this.hostSessionsAutoTimer = undefined;
    }
  }

  private async requestHostSessionInventory(): Promise<void> {
    if (this.hostSessionsRefreshState === "refreshing") return;
    if (!this.guardSafetyAction("host_session_refresh")) {
      this.hostSessionsRefreshState = "idle";
      this.hostSessionsRefreshSummary = undefined;
      return;
    }
    this.actionError = undefined;
    this.actionNotice = undefined;
    this.hostSessionsRefreshState = "refreshing";
    this.hostSessionsRefreshSummary = undefined;
    try {
      const response = await refreshHostSessions();
      this.hostSessionsRefreshSummary = refreshSummary(response);
      if (response.dispatched_to > 0 && this.realtimeState !== "live") {
        window.setTimeout(() => {
          void this.load().catch((error) => {
            this.actionError = actionErrorMessage("Host session refresh load failed", error);
          });
        }, 2_000);
      }
      this.hostSessionsRefreshState = "idle";
    } catch (error) {
      this.hostSessionsRefreshState = "failed";
      this.mergeSafetyPostureFromError(error);
      this.stopHostSessionsAutoRefreshIfBlocked();
      this.actionError = actionErrorMessage("Host session refresh failed", error);
    }
  }

  private readonly bootstrapBudgetSamples = async (): Promise<void> => {
    this.actionError = undefined;
    this.actionNotice = undefined;
    if (!this.guardSafetyAction("budget_bootstrap")) return;
    try {
      const budget = await requestBudgetBootstrap();
      const safetyResponse = await loadSafetyPosture();
      if (!this.data) return;
      this.data = {
        ...this.data,
        budget,
        safety: safetyResponse.safety
      };
      this.actionNotice = "Budget samples bootstrapped.";
    } catch (error) {
      this.mergeSafetyPostureFromError(error);
      this.actionError = actionErrorMessage("Budget bootstrap failed", error);
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

  private mergeSafetyPosture(safety: BootstrapPayload["safety"]): void {
    if (!this.data) return;
    this.data = {
      ...this.data,
      safety
    };
  }

  private mergeSafetyPostureFromError(error: unknown): void {
    if (!(error instanceof ApiError) || !isSafetyPosturePayload(error.payload)) return;
    this.mergeSafetyPosture(error.payload.safety);
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
    if (this.selectedThreadId !== threadId) {
      this.resetThreadCommandState();
    }
    this.selectedThreadId = threadId;
    this.commandModeExplicit = false;
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
    const previousThreadId = this.selectedThreadId;
    const selected = this.selectedThread();
    this.selectedThreadId = selected?.id;
    if (previousThreadId !== this.selectedThreadId) {
      this.resetThreadCommandState();
    }
    this.ensureCommandMode();
  }

  private resetThreadCommandState(): void {
    this.lastCommandId = undefined;
    this.commandState = "idle";
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
    if (this.view !== "thread-centre") return;
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
          this.commandModeExplicit = true;
        }}
      >
        ${commandModeLabel(mode)}
      </button>
    `;
  }

  private ensureCommandMode(): void {
    const thread = this.selectedThread();
    if (!this.commandModeExplicit && this.commandMode === "placeholder") {
      this.commandMode = defaultCommandMode(this.data, thread?.id);
      return;
    }
    const nextMode = normaliseCommandMode(this.commandMode, this.data, thread?.id, {
      showCliFallback: SHOW_CODEX_CLI_FALLBACK,
      preferManagedAppServer: !this.commandModeExplicit
    });
    if (nextMode !== this.commandMode) {
      this.commandMode = nextMode;
      this.commandModeExplicit = false;
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
        this.startBudgetPolling();
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
    this.stopBudgetPolling();
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
    this.stopBudgetPolling();
    if (this.pollTimer !== undefined) return;
    void this.load();
    this.pollTimer = window.setInterval(() => void this.load(), FALLBACK_POLL_MS);
  }

  private stopFallbackPolling(): void {
    if (this.pollTimer === undefined) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private startBudgetPolling(): void {
    if (this.budgetTimer !== undefined) return;
    this.budgetTimer = window.setInterval(() => void this.refreshBudgetSummary(), BUDGET_REFRESH_MS);
  }

  private stopBudgetPolling(): void {
    if (this.budgetTimer === undefined) return;
    window.clearInterval(this.budgetTimer);
    this.budgetTimer = undefined;
  }

  private async refreshBudgetSummary(): Promise<void> {
    if (!this.data) return;
    try {
      const [budget, safetyResponse] = await Promise.all([
        loadUsageSummary(),
        loadSafetyPosture()
      ]);
      this.data = {
        ...this.data,
        budget,
        safety: safetyResponse.safety
      };
      this.stopHostSessionsAutoRefreshIfBlocked();
      if (this.actionError?.startsWith("Budget refresh failed:")) {
        this.actionError = undefined;
      }
    } catch (error) {
      if (this.view === "budget-board") {
        this.actionError = actionErrorMessage("Budget refresh failed", error);
      }
    }
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
    this.data = {
      ...this.data,
      host_sessions: mergeHostSessions(payload.host_sessions, this.data.host_sessions, {
        snapshotConnectorId: payload.snapshot ? payload.connector_id : undefined
      })
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

function safetyChipLabel(safety: BootstrapPayload["safety"]): string {
  if (safety.paused) return "Paused";
  if (safety.state === "hard_limited") return "Hard limit";
  return `Safety ${safety.state.replace("_", " ")}`;
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

function refreshSummary(response: RefreshHostSessionsResponse): string {
  const debouncedCount = response.debounced_connector_count ?? 0;
  if (response.dispatched_to === 0 && debouncedCount > 0) {
    const cooldown = response.cooldown_ms ? ` for ${formatAge(response.cooldown_ms)}` : "";
    const connectorLabel = debouncedCount === 1 ? "connector" : "connectors";
    return `Refresh already requested recently on ${debouncedCount} online ${connectorLabel}${cooldown}.`;
  }
  if (response.dispatched_to === 0) return "No online connector accepted the refresh request.";
  const dispatchedLabel = response.dispatched_to === 1
    ? "Refresh requested from 1 online connector"
    : `Refresh requested from ${response.dispatched_to} online connectors`;
  if (debouncedCount === 0) return `${dispatchedLabel}.`;
  const debouncedLabel = debouncedCount === 1
    ? "1 connector was already cooling down"
    : `${debouncedCount} connectors were already cooling down`;
  return `${dispatchedLabel}; ${debouncedLabel}.`;
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

function budgetWindowLabel(windowType: NonNullable<BudgetSummary["windows"]>[number]["window_type"]): string {
  return {
    daily: "Daily",
    four_hour: "4-hour",
    burst: "Burst"
  }[windowType];
}

function newestBudgetWindowUpdatedAt(budget: BudgetSummary): string | undefined {
  return budgetWindows(budget).reduce<string | undefined>((newest, window) => {
    return newest && newest > window.updated_at ? newest : window.updated_at;
  }, undefined);
}

function budgetConstraints(budget: BudgetSummary): BudgetConstraint[] {
  if (budget.constraints) return budget.constraints;
  const windowsByType = new Map(budgetWindows(budget).map((window) => [window.window_type, window]));
  return [
    legacyBudgetConstraint(
      "legacy_daily",
      "Daily budget",
      "Legacy daily usage percentage from a control plane that does not report detailed constraints.",
      "daily",
      budget.daily_used_pct,
      windowsByType.get("daily"),
      budget.state
    ),
    legacyBudgetConstraint(
      "legacy_four_hour",
      "4-hour window",
      "Legacy four-hour usage percentage from a control plane that does not report detailed constraints.",
      "four_hour",
      budget.four_hour_used_pct,
      windowsByType.get("four_hour"),
      budget.state
    ),
    legacyBudgetConstraint(
      "legacy_burst",
      "Burst window",
      "Legacy burst usage percentage from a control plane that does not report detailed constraints.",
      "burst",
      budget.burst_used_pct,
      windowsByType.get("burst"),
      budget.state
    )
  ];
}

function legacyBudgetConstraint(
  id: string,
  label: string,
  detail: string,
  windowType: BudgetConstraint["window_type"],
  usedPct: number | null | undefined,
  window: BudgetWindow | undefined,
  summaryState: BudgetSummary["state"]
): BudgetConstraint {
  const limitUnits = window?.budget_units ?? null;
  const usedUnits = window?.events_received ?? null;
  const remainingUnits = limitUnits === null || usedUnits === null ? null : Math.max(0, limitUnits - usedUnits);
  const remainingRatio = usedPct === null || usedPct === undefined || !Number.isFinite(usedPct)
    ? null
    : Math.max(0, Math.round((1 - usedPct / 100) * 1000) / 1000);
  return {
    id,
    label,
    detail,
    window_type: windowType,
    unit: "event",
    hard: true,
    sampled: usedPct !== null && usedPct !== undefined,
    state: window?.budget_state ?? (usedPct === null || usedPct === undefined ? "missing" : summaryState),
    source: usedPct === null || usedPct === undefined ? "missing" : "d1_usage_windows",
    limit_units: limitUnits,
    used_units: usedUnits,
    used_pct: usedPct ?? null,
    remaining_units: remainingUnits,
    remaining_ratio: remainingRatio,
    per_event_units: 1,
    remaining_event_capacity: remainingUnits,
    window_start: window?.window_start,
    window_end: window?.window_end,
    updated_at: window?.updated_at
  };
}

function budgetBottleneckConstraint(budget: BudgetSummary): BudgetConstraint | undefined {
  return budget.bottleneck_constraint ?? budgetConstraints(budget)
    .filter((constraint) =>
      constraint.hard
      && constraint.sampled
      && constraint.remaining_ratio !== null
      && constraint.state !== "missing"
    )
    .sort(compareBudgetConstraintsByRemainingRatio)[0];
}

function compareBudgetConstraintsByRemainingRatio(left: BudgetConstraint, right: BudgetConstraint): number {
  const ratioDelta = (left.remaining_ratio ?? Number.POSITIVE_INFINITY) - (right.remaining_ratio ?? Number.POSITIVE_INFINITY);
  if (ratioDelta !== 0) return ratioDelta;
  const capacityDelta =
    (left.remaining_event_capacity ?? Number.POSITIVE_INFINITY)
    - (right.remaining_event_capacity ?? Number.POSITIVE_INFINITY);
  if (capacityDelta !== 0) return capacityDelta;
  return left.id.localeCompare(right.id);
}

function budgetWindows(budget: BudgetSummary): BudgetWindow[] {
  return budget.windows ?? [];
}

function budgetWindowDetail(window: BudgetWindow): string {
  const events = `${window.events_received.toLocaleString("en-GB")} events`;
  const budget = window.budget_units === undefined
    ? ""
    : ` / ${window.budget_units.toLocaleString("en-GB")} units`;
  const estimatedRows = window.estimated_d1_rows_written === undefined
    ? ""
    : `, ${window.estimated_d1_rows_written.toLocaleString("en-GB")} modelled D1 rows`;
  return `${events}${budget}${estimatedRows}`;
}

function budgetConstraintDetail(constraint: BudgetConstraint): string {
  if (!constraint.sampled) {
    const limit = constraint.limit_units === null ? "unknown limit" : `${formatCount(constraint.limit_units)} ${budgetConstraintUnitLabel(constraint.unit)}`;
    return `limit ${limit}; usage sample missing`;
  }
  const used = constraint.used_units === null ? "missing" : formatCount(constraint.used_units);
  const limit = constraint.limit_units === null ? "unknown" : formatCount(constraint.limit_units);
  const remaining = constraint.remaining_units === null ? "missing" : formatCount(constraint.remaining_units);
  const capacity = constraint.remaining_event_capacity === null
    ? ""
    : `, ${formatCount(constraint.remaining_event_capacity)} events left`;
  const source = constraint.source === "schema_model" ? "; local model baseline" : "";
  return `${used} / ${limit} ${budgetConstraintUnitLabel(constraint.unit)}, ${remaining} remaining${capacity}${source}`;
}

function budgetConstraintSampleLabel(sampled: number, total: number): string {
  return total === 0 ? "no constraints" : `${sampled}/${total} constraints`;
}

function budgetRemainingLabel(constraint: BudgetConstraint): string {
  if (constraint.remaining_ratio === null) return "missing";
  const percent = budgetPctLabel(constraint.remaining_ratio * 100);
  const capacity = constraint.remaining_event_capacity === null
    ? ""
    : `, ${formatCount(constraint.remaining_event_capacity)} events`;
  return `${percent}${capacity}`;
}

function budgetCompactLabel(constraint: BudgetConstraint | undefined): string {
  if (!constraint || constraint.remaining_ratio === null) return "Budget missing";
  return `Budget ${budgetPctLabel(constraint.remaining_ratio * 100)} left`;
}

function budgetCompactState(budget: BudgetSummary, constraint: BudgetConstraint | undefined): BudgetSummary["state"] | "missing" {
  if (constraint || budget.state !== "normal") return budget.state;
  return "missing";
}

function budgetConstraintUnitLabel(unit: BudgetConstraint["unit"]): string {
  return {
    event: "events",
    d1_row: "D1 rows written",
    d1_row_read: "D1 rows read",
    worker_request: "Worker requests",
    durable_object_request: "DO requests",
    byte: "bytes",
    operation: "operations"
  }[unit];
}

function formatCount(value: number): string {
  return value.toLocaleString("en-GB");
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

function isSafetyPosturePayload(value: unknown): value is { safety: BootstrapPayload["safety"] } {
  if (typeof value !== "object" || value === null) return false;
  const safety = (value as { safety?: unknown }).safety;
  if (typeof safety !== "object" || safety === null) return false;
  return (
    typeof (safety as { state?: unknown }).state === "string"
    && typeof (safety as { paused?: unknown }).paused === "boolean"
    && Array.isArray((safety as { actions?: unknown }).actions)
  );
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

function turnStatusLabel(status: ThreadTurnSummary["status"]): string {
  return {
    pending: "Accepted",
    running: "Running",
    waiting: "Waiting",
    succeeded: "Done",
    failed: "Failed"
  }[status];
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

function budgetTelemetryTrend(budget: BudgetSummary) {
  const history = budget.telemetry_history;
  const points = (history?.points ?? []).filter(
    (point): point is BudgetTelemetryPointWithWrites => point.d1_rows_written_daily !== null
  );
  const latest = points.at(-1);
  const slopes = history?.slopes ?? [];
  const limit = budget.d1_write_model?.free_rows_written_per_day ?? 100_000;

  if (!history || points.length === 0) {
    return html`
      <section class="budget-trend missing">
        <div>
          <h3>D1 rows written trend</h3>
          <span>missing</span>
        </div>
        <p>No Cloudflare telemetry samples have been persisted yet.</p>
      </section>
    `;
  }

  const plotted = budgetTelemetryPlot(points, limit);
  return html`
    <section class="budget-trend">
      <div class="budget-trend-header">
        <div>
          <h3>D1 rows written trend</h3>
          <span>${points.length.toLocaleString("en-GB")} samples</span>
        </div>
        <strong title=${latest ? formatAbsoluteIso(latest.sampled_at) : ""}>
          ${latest ? formatCount(latest.d1_rows_written_daily) : "missing"}
        </strong>
      </div>
      <svg class="budget-trend-chart" viewBox="0 0 640 180" role="img" aria-label="D1 rows written over time">
        <line x1="44" y1="150" x2="620" y2="150"></line>
        <line x1="44" y1="24" x2="44" y2="150"></line>
        <polyline points=${plotted.polyline}></polyline>
        ${plotted.points.map(
          (point) => html`<circle cx=${point.x} cy=${point.y} r="3"><title>${formatCount(point.value)} rows at ${formatAbsoluteIso(point.sampled_at)}</title></circle>`
        )}
        <text x="44" y="18">${formatCount(plotted.yMax)}</text>
        <text x="44" y="170">${formatTimeLabel(points[0]!.sampled_at)}</text>
        <text x="620" y="170" text-anchor="end">${formatTimeLabel(points.at(-1)!.sampled_at)}</text>
      </svg>
      <div class="budget-slopes">
        ${slopes.map((slope) => html`
          <div>
            <span>${slope.window}</span>
            <strong>${budgetSlopePrimaryLabel(slope)}</strong>
            <small>${budgetSlopeSecondaryLabel(slope)}</small>
          </div>
        `)}
      </div>
    </section>
  `;
}

function budgetTelemetryPlot(points: BudgetTelemetryPointWithWrites[], limit: number): {
  yMax: number;
  polyline: string;
  points: Array<{ x: number; y: number; value: number; sampled_at: string }>;
} {
  const chart = {
    left: 44,
    right: 620,
    top: 24,
    bottom: 150
  };
  const timestamps = points.map((point) => Date.parse(point.sampled_at)).filter(Number.isFinite);
  const minX = Math.min(...timestamps);
  const maxX = Math.max(...timestamps);
  const yMax = Math.max(limit, ...points.map((point) => point.d1_rows_written_daily), 1);
  const plotted = points.map((point, index) => {
    const timestamp = Date.parse(point.sampled_at);
    const x = maxX === minX
      ? chart.left + (chart.right - chart.left) / 2
      : chart.left + ((timestamp - minX) / (maxX - minX)) * (chart.right - chart.left);
    const y = chart.bottom - (point.d1_rows_written_daily / yMax) * (chart.bottom - chart.top);
    return {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      value: point.d1_rows_written_daily,
      sampled_at: point.sampled_at,
      index
    };
  });
  return {
    yMax,
    polyline: plotted.map((point) => `${point.x},${point.y}`).join(" "),
    points: plotted
  };
}

function budgetSlopePrimaryLabel(slope: BudgetTelemetrySlope): string {
  if (slope.d1_rows_written_delta === null || slope.d1_rows_written_per_minute === null) return "missing";
  return `${formatCount(slope.d1_rows_written_delta)} rows`;
}

function budgetSlopeSecondaryLabel(slope: BudgetTelemetrySlope): string {
  if (slope.d1_rows_written_per_minute === null || slope.projected_d1_rows_written_daily === null) {
    return `${slope.sample_count} samples`;
  }
  return `${slope.d1_rows_written_per_minute.toLocaleString("en-GB")} rows/min, projected ${formatCount(slope.projected_d1_rows_written_daily)}`;
}

function budgetD1ActivitySignals(budget: BudgetSummary) {
  const signals = budget.d1_activity?.signals ?? [];
  if (signals.length === 0) return nothing;
  return html`
    <section class="budget-activity">
      <h3>D1 write activity</h3>
      <div>
        ${signals.map((signal) => html`
          <article class=${signal.sampled ? "" : "missing"}>
            <span>${signal.label}</span>
            <strong>${signal.rows_written_daily === null ? "missing" : formatCount(signal.rows_written_daily)}</strong>
            <small title=${signal.updated_at ? formatAbsoluteIso(signal.updated_at) : signal.detail}>${signal.detail}</small>
          </article>
        `)}
      </div>
    </section>
  `;
}

function formatTimeLabel(iso: string): string {
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime())) return "unknown";
  return timestamp.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function budgetConstraintBar(constraint: BudgetConstraint) {
  return html`
    <div class="budget-bar ${constraint.sampled ? "" : "missing"}">
      <div>
        <span>${constraint.label}</span>
        <strong>${constraint.sampled ? budgetPctLabel(constraint.used_pct) : "missing"}</strong>
      </div>
      <meter min="0" max="100" value=${meterPct(constraint.used_pct)}></meter>
    </div>
  `;
}

function meterPct(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  return `${mib.toFixed(0)} MiB`;
}

type BudgetWindow = NonNullable<BudgetSummary["windows"]>[number];
type BudgetTelemetryPointWithWrites = NonNullable<BudgetSummary["telemetry_history"]>["points"][number] & {
  d1_rows_written_daily: number;
};
type BudgetTelemetrySlope = NonNullable<BudgetSummary["telemetry_history"]>["slopes"][number];
