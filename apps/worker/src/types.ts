export type Env = {
  DB?: D1Database;
  ARTIFACTS?: R2Bucket;
  WORKSPACE_DO?: DurableObjectNamespace;
  AGENT_BOOTSTRAP_SECRET?: string;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  CHAOP_DEV_ALLOW_INSECURE?: string;
  CHAOP_API_DOMAIN?: string;
  CHAOP_GUI_DOMAIN?: string;
  CHAOP_DAILY_BUDGET_UNITS?: string;
  CHAOP_4H_SOFT_BUDGET_UNITS?: string;
  CHAOP_4H_HARD_BUDGET_UNITS?: string;
  CHAOP_BURST_EVENTS_PER_MINUTE?: string;
};
