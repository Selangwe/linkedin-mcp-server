export type ProspectStatus =
  | "new"
  | "active"
  | "replied"
  | "won"
  | "lost"
  | "paused"
  | "do_not_contact";

/** Statuses that stop a sequence dead. `replied` is the point of the whole exercise. */
export const TERMINAL_STATUSES: ProspectStatus[] = [
  "replied",
  "won",
  "lost",
  "paused",
  "do_not_contact",
];

export type StepChannel =
  | "linkedin_dm"
  | "linkedin_comment"
  | "connection_note"
  | "email"
  | "manual";

export interface SequenceStep {
  /** Stable within a sequence ("s1", "s2"), and part of the dedupe key. */
  key: string;
  channel: StepChannel;
  /** Days to wait after the previous step completed. 0 means "due immediately". */
  delay_days: number;
  /** Supports {{first_name}}, {{full_name}}, {{company}}, {{headline}}, {{custom.*}}. */
  template: string;
  /** Default true: a prospect who replied should not receive step 3. */
  stop_if_replied?: boolean;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
  created_at: number;
}

export type StepMode =
  | "auto_sent"
  | "drafted"
  | "marked_sent_by_human"
  | "skipped"
  | "blocked";

export interface StepEvent {
  step_key: string;
  at: number;
  channel: StepChannel;
  mode: StepMode;
  /** sha256 of the rendered text — proof of exactly what went out. */
  message_digest: string;
  draft_id?: string;
  detail?: string;
}

export type EnrollmentState = "pending" | "awaiting_send" | "completed" | "stopped";

export interface Enrollment {
  sequence_id: string;
  /** Index of the step that is next to happen. */
  step_index: number;
  /** Epoch ms when that step becomes due. */
  next_due_at: number;
  state: EnrollmentState;
  history: StepEvent[];
}

export interface Prospect {
  id: string;
  full_name: string;
  profile_url?: string;
  member_urn?: string;
  headline?: string;
  company?: string;
  tags: string[];
  notes?: string;
  /** Freeform merge fields available to templates as {{custom.key}}. */
  custom?: Record<string, string>;
  source: "manual" | "import" | "provider";
  status: ProspectStatus;
  created_at: number;
  updated_at: number;
  last_touched_at?: number;
  enrollment?: Enrollment;
}

/**
 * The denormalized row kept in the prospect index.
 *
 * IKeyValueStore has no scan, and on Redis a per-prospect read is a network
 * round trip — five hundred of them would blow the 60s function ceiling. So
 * the index carries enough to answer "what is due today" and "who is active"
 * in a single read.
 */
export interface ProspectSummary {
  id: string;
  full_name: string;
  company?: string;
  status: ProspectStatus;
  sequence_id?: string;
  step_index?: number;
  next_due_at?: number;
  last_touched_at?: number;
}

export interface Draft {
  id: string;
  prospect_id: string;
  step_key: string;
  channel: StepChannel;
  text: string;
  /** Where a human should go to send it by hand. */
  profile_url?: string;
  created_at: number;
}

export interface PreparedStep {
  prospect: Prospect;
  step: SequenceStep;
  text: string;
  digest: string;
  /** True when this exact step was already delivered to this prospect. */
  duplicate: boolean;
}
