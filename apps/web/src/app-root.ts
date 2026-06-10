import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  groupTasksByState,
  TASK_STATE_LABELS,
  type BootstrapPayload,
  type ConnectorSummary,
  type TaskState,
  type TaskSummary,
  type ThreadEvent,
  type ThreadSummary
} from "@chaop/protocol";
import { createPlaceholderCommand, loadBootstrap } from "./api.js";

type View = "operations-map" | "task-board" | "thread-centre" | "budget-board";

@customElement("chaop-app")
export class ChaopApp extends LitElement {
  static override styles = css``;

  @state()
  private data?: BootstrapPayload;

  @state()
  private view: View = "operations-map";

  @state()
  private commandPrompt = "Summarise the current failure pattern and next action.";

  @state()
  private commandState: "idle" | "submitting" | "accepted" | "failed" = "idle";

  @state()
  private lastCommandId?: string;

  @state()
  private loadError?: string;

  override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.view = viewFromHash();
    window.addEventListener("hashchange", this.onHashChange);
    void this.load();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.onHashChange);
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
            ${this.navItem("thread-centre", "Thread Centre")}
            ${this.navItem("budget-board", "Budget Board")}
          </nav>
        </aside>
        <main>
          ${this.renderTopBar()}
          ${this.view === "operations-map" ? this.renderOperationsMap() : nothing}
          ${this.view === "task-board" ? this.renderTaskBoard() : nothing}
          ${this.view === "thread-centre" ? this.renderThreadCentre() : nothing}
          ${this.view === "budget-board" ? this.renderBudgetBoard() : nothing}
        </main>
      </div>
    `;
  }

  private async load(): Promise<void> {
    try {
      this.data = await loadBootstrap();
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : "Bootstrap request failed";
    }
  }

  private readonly onHashChange = (): void => {
    this.view = viewFromHash();
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
      <a class="lead" href="#thread-centre">
        <strong>${thread.title}</strong>
        <span>${thread.state} · seq ${thread.last_seq}</span>
        <span class="chip ${thread.realtime_mode}">${formatMode(thread.realtime_mode)}</span>
      </a>
    `;
  }

  private renderTaskBoard() {
    const grouped = groupTasksByState(this.data!.tasks);
    const states: TaskState[] = [
      "running",
      "idle",
      "waiting_for_approval",
      "waiting_for_input",
      "throttled",
      "done"
    ];

    return html`
      <section class="task-layout">
        <div class="category-strip">
          ${this.data!.task_categories.map(
            (category) => html`<span style=${`--category:${category.colour}`}>${category.name}</span>`
          )}
          <button type="button">Add category</button>
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
      <article class="task-card">
        <div class="task-title">
          <strong>${task.title}</strong>
          <span style=${`--category:${category?.colour ?? "#64748b"}`}>${category?.name ?? "Uncategorised"}</span>
        </div>
        <div class="task-meta">
          <span>${task.assigned_agent ?? "Unassigned"}</span>
          <span class="chip ${task.realtime_mode}">${formatMode(task.realtime_mode)}</span>
        </div>
      </article>
    `;
  }

  private renderThreadCentre() {
    const thread = this.data!.threads[0];
    if (!thread) return nothing;
    const events = this.eventsForThread(thread.id);
    const command = this.lastCommandId
      ? this.data!.running_commands.find((item) => item.id === this.lastCommandId)
      : this.data!.running_commands[0];

    return html`
      <section class="page-grid thread-grid">
        <section class="panel primary">
          <div class="section-heading">
            <h2>${thread.title}</h2>
            <span class="chip ${thread.realtime_mode}">${formatMode(thread.realtime_mode)}</span>
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
          <button class="primary-action" type="button" @click=${this.submitCommand}>
            ${this.commandState === "submitting" ? "Submitting..." : "Run placeholder command"}
          </button>
          ${this.commandState === "accepted"
            ? html`<p class="command-status success">
                Placeholder command accepted${this.lastCommandId ? `: ${this.lastCommandId}` : ""}.
              </p>`
            : nothing}
          ${this.commandState === "failed"
            ? html`<p class="command-status failed">Command request failed.</p>`
            : nothing}
          <div class="timeline">
            ${events.length > 0
              ? events.map(
                  (event, index) => html`
                    <div class="event-row">
                      <span>${String(index + 1).padStart(2, "0")}</span>
                      <strong>${event.kind}</strong>
                      <p>${event.summary}</p>
                    </div>
                  `
                )
              : ["command.accepted", "command.started", "command.output", "command.finished"].map(
                  (eventName, index) => html`
                    <div class="event-row">
                      <span>${String(index + 1).padStart(2, "0")}</span>
                      <strong>${eventName}</strong>
                      <p>${eventCopy(eventName)}</p>
                    </div>
                  `
                )}
          </div>
        </section>
        <aside class="panel">
          <div class="section-heading">
            <h2>Lease</h2>
            <span>Placeholder target</span>
          </div>
          <dl class="facts">
            <div><dt>Mode</dt><dd>Interactive</dd></div>
            <div><dt>Target</dt><dd>${command?.target_connector_id ?? "Auto-selected"}</dd></div>
            <div><dt>Command state</dt><dd>${command?.state ?? "No live command"}</dd></div>
            <div><dt>Policy</dt><dd>Realtime events, summary logs</dd></div>
            <div><dt>Approval</dt><dd>Stubbed for next slice</dd></div>
            <div><dt>Artifacts</dt><dd>Entry point only</dd></div>
          </dl>
        </aside>
      </section>
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
    this.commandState = "submitting";
    try {
      const response = await createPlaceholderCommand({
        workspace_id: "workspace-api",
        thread_id: "thread-orders-500",
        task_id: "task-orders-500",
        prompt: this.commandPrompt
      });
      this.lastCommandId = response.command.id;
      this.commandState = "accepted";
      await this.load();
      window.setTimeout(() => void this.load(), 1_000);
      window.setTimeout(() => void this.load(), 2_500);
    } catch {
      this.commandState = "failed";
    }
  };

  private eventsForThread(threadId: string): ThreadEvent[] {
    return this.data!.events.filter((event) => event.thread_id === threadId);
  }
}

function viewFromHash(): View {
  const value = window.location.hash.replace("#", "");
  if (value === "task-board" || value === "thread-centre" || value === "budget-board") {
    return value;
  }
  return "operations-map";
}

function viewTitle(view: View): string {
  return {
    "operations-map": "Operations Map",
    "task-board": "Operations Task Board",
    "thread-centre": "Thread Command Centre",
    "budget-board": "Budget Reliability Board"
  }[view];
}

function viewQuestion(view: View): string {
  return {
    "operations-map": "Is the fleet healthy, and where should I look next?",
    "task-board": "What work is moving, blocked, waiting, or done?",
    "thread-centre": "What is happening inside this one task right now?",
    "budget-board": "What is the current cost and reliability posture?"
  }[view];
}

function formatMode(mode: string): string {
  return mode.replaceAll("_", " ");
}

function eventCopy(eventName: string): string {
  return {
    "command.accepted": "Control plane accepted the placeholder command.",
    "command.started": "connector-mac-studio acquired the lease.",
    "command.output": "Summary stream is current; full log detail is deferred.",
    "command.finished": "Placeholder command completed successfully."
  }[eventName] ?? "Event received.";
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
