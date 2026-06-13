import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  groupTasksByState,
  TASK_STATE_LABELS,
  type BootstrapPayload,
  type CommandSummary,
  type ConnectorSummary,
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
  refreshHostSessions,
  unarchiveTask
} from "./api.js";
import { mergeBootstrapPayload } from "./state.js";

type View = "operations-map" | "task-board" | "host-sessions" | "thread-centre" | "budget-board";
type TaskBoardMode = "active" | "archive";
type RealtimeState = "connecting" | "live" | "polling";
type RealtimeThreadEventPayload = {
  event: ThreadEvent;
};
type RealtimeHostSessionsPayload = HostSessionsUpdatePayload;

const FALLBACK_POLL_MS = 10_000;
const SOCKET_RECONNECT_MS = 3_000;

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
  private commandType: CommandSummary["type"] = "placeholder";

  @state()
  private commandState: "idle" | "submitting" | "accepted" | "failed" = "idle";

  @state()
  private lastCommandId: string | undefined;

  @state()
  private loadError: string | undefined;

  @state()
  private actionError: string | undefined;

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
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : "Bootstrap request failed";
    }
  }

  private readonly onHashChange = (): void => {
    this.view = viewFromHash();
    this.selectedThreadId = threadIdFromHash();
    this.ensureSelectedThread();
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
            <h2>Look next</h2>
            <span>Focused leads</span>
          </div>
          ${this.data!.threads.slice(0, 3).map((thread) => this.threadLead(thread))}
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
        <span>${connector.logical_agent_count} agents</span>
        <span>${connector.active_command_count} running</span>
        <span class="chip ${connector.realtime_mode}">${formatMode(connector.realtime_mode)}</span>
      </div>
    `;
  }

  private threadLead(thread: ThreadSummary) {
    return html`
      <a class="lead" href=${threadHref(thread.id)}>
        <strong>${thread.title}</strong>
        <span>${thread.state} · seq ${thread.last_seq}</span>
        <span class="chip ${thread.realtime_mode}">${formatMode(thread.realtime_mode)}</span>
      </a>
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
            ${this.commandModeButton("placeholder", "Placeholder")}
            ${this.commandModeButton("codex", "Codex exec")}
          </div>
          <button
            class="primary-action"
            type="button"
            ?disabled=${this.commandState === "submitting" || this.commandPrompt.trim().length === 0}
            @click=${this.submitCommand}
          >
            ${this.commandState === "submitting" ? "Submitting..." : `Run ${formatCommandType(this.commandType)} command`}
          </button>
          ${this.commandState === "accepted"
            ? html`<p class="command-status success">
                ${formatCommandType(this.commandType)} command accepted${this.lastCommandId ? `: ${this.lastCommandId}` : ""}.
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
          ${this.renderCreateThreadForm("stacked")}
          <div class="thread-list">
            ${this.activeThreads().map((item) => this.threadListItem(item))}
          </div>
          <div class="section-heading">
            <h2>Lease</h2>
            <span>${formatCommandType(this.commandType)} target</span>
          </div>
          <dl class="facts">
            <div><dt>Mode</dt><dd>Interactive</dd></div>
            <div><dt>Execution</dt><dd>${formatCommandType(command?.type ?? this.commandType)}</dd></div>
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
        </aside>
      </section>
    `;
  }

  private hostSessionRow(session: HostSessionSummary) {
    const attachedThreadId = session.attached_thread_id;
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
    this.commandState = "submitting";
    this.actionError = undefined;
    try {
      const response = await createCommand({
        workspace_id: thread.workspace_id,
        thread_id: thread.id,
        task_id: task?.id,
        type: this.commandType,
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

  private renderCreateThreadForm(layout: "compact" | "stacked") {
    const workspace = this.data?.workspaces[0];
    const connectors = this.data?.connectors ?? [];
    return html`
      <form class=${`create-thread-form ${layout}`} @submit=${this.submitLocalThreadCreate}>
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
          .value=${this.newThreadConnectorId}
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
          ?disabled=${this.newThreadState === "creating" || !workspace}
        >
          ${this.newThreadState === "creating" ? "Creating..." : "New local thread"}
        </button>
      </form>
    `;
  }

  private readonly submitLocalThreadCreate = async (event: Event): Promise<void> => {
    event.preventDefault();
    const workspace = this.data?.workspaces[0];
    if (!workspace) {
      this.newThreadState = "failed";
      this.actionError = "No workspace is available for local thread creation";
      return;
    }

    const title = this.newThreadTitle.trim() || "New Codex thread";
    this.newThreadState = "creating";
    this.actionError = undefined;
    try {
      const response = await createLocalThread({
        workspace_id: workspace.id,
        title,
        connector_id: this.newThreadConnectorId || undefined
      });
      this.mergeAttachedSession(response);
      this.newThreadState = "idle";
      this.newThreadTitle = "New Codex thread";
      this.openThread(response.thread.id);
      await this.load();
    } catch (error) {
      this.newThreadState = "failed";
      this.actionError = actionErrorMessage("Thread creation failed", error);
    }
  };

  private async toggleTaskArchive(task: TaskSummary): Promise<void> {
    this.actionError = undefined;
    try {
      const response = task.archived_at
        ? await unarchiveTask(task.id)
        : await archiveTask(task.id);
      this.mergeArchivedTask(response.task);
      await this.load();
    } catch (error) {
      this.actionError = actionErrorMessage(task.archived_at ? "Unarchive failed" : "Archive failed", error);
    }
  }

  private async attachSession(session: HostSessionSummary): Promise<void> {
    this.actionError = undefined;
    try {
      const response = await attachHostSession(session.session_id, { connector_id: session.connector_id });
      this.mergeAttachedSession(response);
      this.openThread(response.thread.id);
    } catch (error) {
      this.actionError = actionErrorMessage("Attach failed", error);
    }
  }

  private async detachSession(session: HostSessionSummary): Promise<void> {
    this.actionError = undefined;
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
    window.location.hash = `thread-centre?thread=${encodeURIComponent(threadId)}`;
  }

  private selectedThread(): ThreadSummary | undefined {
    if (!this.data) return undefined;
    return this.data.threads.find((thread) => thread.id === this.selectedThreadId) ?? this.activeThreads()[0] ?? this.data.threads[0];
  }

  private ensureSelectedThread(): void {
    if (!this.data || this.view !== "thread-centre") return;
    const selected = this.selectedThread();
    this.selectedThreadId = selected?.id;
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

  private commandModeButton(type: CommandSummary["type"], label: string) {
    return html`
      <button
        type="button"
        class=${this.commandType === type ? "active" : ""}
        ?disabled=${this.commandState === "submitting"}
        @click=${() => {
          this.commandType = type;
        }}
      >
        ${label}
      </button>
    `;
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

function threadHref(threadId: string): string {
  return `#thread-centre?thread=${encodeURIComponent(threadId)}`;
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
  return type === "codex" ? "Codex exec" : "Placeholder";
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
  return `Last synced: ${timestamp} (${formatAge(nowMs - syncedAt.getTime())} ago)`;
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
