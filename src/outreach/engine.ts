import crypto from "crypto";
import type { IKeyValueStore } from "../services/kv-store.js";
import {
  TERMINAL_STATUSES,
  type Draft,
  type Enrollment,
  type PreparedStep,
  type Prospect,
  type ProspectStatus,
  type ProspectSummary,
  type Sequence,
  type SequenceStep,
  type StepEvent,
} from "./types.js";

const DAY_MS = 86_400_000;
const DRAFT_TTL_SECONDS = 30 * 24 * 3600;
const DEDUPE_TTL_SECONDS = 365 * 24 * 3600;

/**
 * Past this many prospects the index read stops being cheap and the
 * read-modify-write below stops being defensible. That is the line where this
 * should become a real database rather than growing another layer here.
 */
const INDEX_SOFT_LIMIT = 2000;

export class OutreachError extends Error {}

export function prospectId(input: { profile_url?: string; full_name: string; company?: string }): string {
  const basis = input.profile_url
    ? normalizeProfileUrl(input.profile_url)
    : `${input.full_name.toLowerCase()}|${(input.company ?? "").toLowerCase()}`;
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

/** Strips query strings and trailing slashes so the same profile hashes alike. */
export function normalizeProfileUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Renders a step's template for a prospect.
 *
 * An unresolved placeholder is a hard error, never a silent pass-through:
 * sending someone a message that literally reads "Hi {{first_name}}" is worse
 * than sending nothing at all.
 */
export function render(step: SequenceStep, prospect: Prospect): string {
  const first = prospect.full_name.trim().split(/\s+/)[0] ?? "";
  const values: Record<string, string | undefined> = {
    first_name: first,
    full_name: prospect.full_name,
    company: prospect.company,
    headline: prospect.headline,
    ...Object.fromEntries(
      Object.entries(prospect.custom ?? {}).map(([k, v]) => [`custom.${k}`, v])
    ),
  };

  const missing: string[] = [];
  const text = step.template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return "";
    }
    return value;
  });

  if (missing.length) {
    throw new OutreachError(
      `Cannot render step ${step.key} for ${prospect.full_name}: no value for ${[...new Set(missing)].join(", ")}. Fill it in with linkedin_prospect_update (custom fields are available as {{custom.key}}) or edit the template.`
    );
  }
  return text;
}

export function digestOf(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export interface DueItem {
  prospect_id: string;
  full_name: string;
  company?: string;
  sequence_id: string;
  step_index: number;
  next_due_at: number;
  overdue_days: number;
}

/**
 * Prospects, sequences and follow-up state, held in this server's own KV
 * store. Deliberately independent of any LinkedIn capability: drafting and
 * tracking work whether or not anything can be sent programmatically.
 */
export class OutreachEngine {
  constructor(private readonly kv: IKeyValueStore) {}

  // --- prospects -------------------------------------------------------

  async getProspect(id: string): Promise<Prospect | null> {
    return this.kv.get<Prospect>(`prospect:${id}`);
  }

  async listProspects(): Promise<ProspectSummary[]> {
    return (await this.kv.get<ProspectSummary[]>("index:prospects")) ?? [];
  }

  async upsertProspect(
    input: Omit<Prospect, "id" | "created_at" | "updated_at" | "tags" | "status" | "source"> & {
      tags?: string[];
      status?: ProspectStatus;
      source?: Prospect["source"];
    }
  ): Promise<{ prospect: Prospect; created: boolean }> {
    const id = prospectId(input);
    const existing = await this.getProspect(id);
    const now = Date.now();

    const prospect: Prospect = {
      ...existing,
      ...input,
      id,
      tags: input.tags ?? existing?.tags ?? [],
      status: input.status ?? existing?.status ?? "new",
      source: input.source ?? existing?.source ?? "manual",
      custom: { ...existing?.custom, ...input.custom },
      created_at: existing?.created_at ?? now,
      updated_at: now,
      enrollment: existing?.enrollment,
    };

    await this.save(prospect);
    return { prospect, created: !existing };
  }

  async updateProspect(
    id: string,
    patch: Partial<Pick<Prospect, "status" | "tags" | "notes" | "company" | "headline" | "custom">>
  ): Promise<Prospect> {
    const prospect = await this.requireProspect(id);
    const next: Prospect = {
      ...prospect,
      ...patch,
      custom: patch.custom ? { ...prospect.custom, ...patch.custom } : prospect.custom,
      updated_at: Date.now(),
    };

    // Reaching a terminal status stops the sequence. That is the entire point
    // of tracking replies: nobody should get step 3 after answering step 2.
    if (patch.status && TERMINAL_STATUSES.includes(patch.status) && next.enrollment) {
      next.enrollment = { ...next.enrollment, state: "stopped" };
    }

    await this.save(next);
    return next;
  }

  // --- sequences -------------------------------------------------------

  async defineSequence(name: string, steps: SequenceStep[]): Promise<Sequence> {
    if (!steps.length) throw new OutreachError("A sequence needs at least one step.");
    const keys = new Set(steps.map((s) => s.key));
    if (keys.size !== steps.length) throw new OutreachError("Step keys must be unique within a sequence.");

    const sequence: Sequence = {
      id: crypto.createHash("sha1").update(name.toLowerCase()).digest("hex").slice(0, 12),
      name,
      steps,
      created_at: Date.now(),
    };
    await this.kv.set(`sequence:${sequence.id}`, sequence);

    const index = (await this.kv.get<Array<{ id: string; name: string }>>("index:sequences")) ?? [];
    if (!index.some((s) => s.id === sequence.id)) {
      index.push({ id: sequence.id, name: sequence.name });
      await this.kv.set("index:sequences", index);
    }
    return sequence;
  }

  async getSequence(id: string): Promise<Sequence | null> {
    return this.kv.get<Sequence>(`sequence:${id}`);
  }

  async listSequences(): Promise<Array<{ id: string; name: string }>> {
    return (await this.kv.get<Array<{ id: string; name: string }>>("index:sequences")) ?? [];
  }

  // --- enrollment ------------------------------------------------------

  async enroll(prospectId: string, sequenceId: string): Promise<Prospect> {
    const prospect = await this.requireProspect(prospectId);
    const sequence = await this.getSequence(sequenceId);
    if (!sequence) throw new OutreachError(`No sequence with id ${sequenceId}.`);

    if (prospect.status === "do_not_contact") {
      throw new OutreachError(`${prospect.full_name} is marked do_not_contact and cannot be enrolled.`);
    }

    const enrollment: Enrollment = {
      sequence_id: sequence.id,
      step_index: 0,
      next_due_at: Date.now() + (sequence.steps[0].delay_days ?? 0) * DAY_MS,
      state: "pending",
      history: prospect.enrollment?.history ?? [],
    };

    const next: Prospect = {
      ...prospect,
      status: prospect.status === "new" ? "active" : prospect.status,
      enrollment,
      updated_at: Date.now(),
    };
    await this.save(next);
    return next;
  }

  /** What is due now, newest overdue first. A pure read over the index. */
  async due(now = Date.now(), limit = 25): Promise<DueItem[]> {
    const index = await this.listProspects();
    return index
      .filter(
        (row) =>
          row.sequence_id &&
          row.next_due_at !== undefined &&
          row.next_due_at <= now &&
          !TERMINAL_STATUSES.includes(row.status)
      )
      .sort((a, b) => (a.next_due_at ?? 0) - (b.next_due_at ?? 0))
      .slice(0, limit)
      .map((row) => ({
        prospect_id: row.id,
        full_name: row.full_name,
        company: row.company,
        sequence_id: row.sequence_id as string,
        step_index: row.step_index ?? 0,
        next_due_at: row.next_due_at as number,
        overdue_days: Math.floor((now - (row.next_due_at as number)) / DAY_MS),
      }));
  }

  /**
   * Works out what the next step for a prospect would say, without doing
   * anything about it. Everything that could refuse — terminal status, a
   * finished sequence, an unresolved placeholder — refuses here, before any
   * send path is entered.
   */
  async prepare(prospectId: string): Promise<PreparedStep> {
    const prospect = await this.requireProspect(prospectId);
    const enrollment = prospect.enrollment;
    if (!enrollment) {
      throw new OutreachError(`${prospect.full_name} is not enrolled in a sequence.`);
    }
    if (enrollment.state === "stopped") {
      throw new OutreachError(
        `The sequence for ${prospect.full_name} is stopped (status: ${prospect.status}).`
      );
    }
    if (TERMINAL_STATUSES.includes(prospect.status)) {
      throw new OutreachError(
        `${prospect.full_name} is marked ${prospect.status}, so no further steps should be sent.`
      );
    }

    const sequence = await this.getSequence(enrollment.sequence_id);
    if (!sequence) throw new OutreachError(`Sequence ${enrollment.sequence_id} no longer exists.`);

    const step = sequence.steps[enrollment.step_index];
    if (!step) {
      throw new OutreachError(
        `${prospect.full_name} has finished every step of "${sequence.name}".`
      );
    }

    const text = render(step, prospect);
    const digest = digestOf(text);
    const duplicate = Boolean(await this.kv.get(this.dedupeKey(prospect.id, step.key)));

    return { prospect, step, text, digest, duplicate };
  }

  async saveDraft(draft: Omit<Draft, "id" | "created_at">): Promise<Draft> {
    const full: Draft = {
      ...draft,
      id: crypto.randomBytes(8).toString("hex"),
      created_at: Date.now(),
    };
    await this.kv.set(`draft:${full.id}`, full, DRAFT_TTL_SECONDS);
    return full;
  }

  async getDraft(id: string): Promise<Draft | null> {
    return this.kv.get<Draft>(`draft:${id}`);
  }

  /**
   * Records that a step happened and schedules the next one.
   *
   * `awaiting_send` is the normal resting state today: the message was drafted
   * for a human to send, and the sequence only advances once they confirm they
   * sent it.
   */
  async complete(
    prospectId: string,
    event: StepEvent,
    opts: { advance?: boolean } = {}
  ): Promise<Prospect> {
    const prospect = await this.requireProspect(prospectId);
    const enrollment = prospect.enrollment;
    if (!enrollment) throw new OutreachError(`${prospect.full_name} is not enrolled in a sequence.`);

    const sequence = await this.getSequence(enrollment.sequence_id);
    if (!sequence) throw new OutreachError(`Sequence ${enrollment.sequence_id} no longer exists.`);

    const history = [...enrollment.history, event];
    const advance = opts.advance ?? event.mode !== "drafted";

    let next: Enrollment;
    if (!advance) {
      // Drafted: hold here until a human says it went out.
      next = { ...enrollment, state: "awaiting_send", history };
    } else {
      const nextIndex = enrollment.step_index + 1;
      const nextStep = sequence.steps[nextIndex];
      next = {
        ...enrollment,
        step_index: nextIndex,
        history,
        state: nextStep ? "pending" : "completed",
        next_due_at: nextStep
          ? Date.now() + (nextStep.delay_days ?? 0) * DAY_MS
          : enrollment.next_due_at,
      };
      await this.kv.set(this.dedupeKey(prospectId, event.step_key), true, DEDUPE_TTL_SECONDS);
    }

    const updated: Prospect = {
      ...prospect,
      enrollment: next,
      last_touched_at: event.at,
      updated_at: Date.now(),
    };
    await this.save(updated);
    return updated;
  }

  async stop(prospectId: string, reason: string): Promise<Prospect> {
    const prospect = await this.requireProspect(prospectId);
    const updated: Prospect = {
      ...prospect,
      notes: prospect.notes ? `${prospect.notes}\n${reason}` : reason,
      enrollment: prospect.enrollment
        ? { ...prospect.enrollment, state: "stopped" }
        : prospect.enrollment,
      updated_at: Date.now(),
    };
    await this.save(updated);
    return updated;
  }

  // --- internals -------------------------------------------------------

  private dedupeKey(prospectId: string, stepKey: string): string {
    return `dedupe:${crypto.createHash("sha256").update(`${prospectId}:${stepKey}`).digest("hex").slice(0, 24)}`;
  }

  private async requireProspect(id: string): Promise<Prospect> {
    const prospect = await this.getProspect(id);
    if (!prospect) throw new OutreachError(`No prospect with id ${id}.`);
    return prospect;
  }

  /**
   * Writes the record and refreshes its index row.
   *
   * The index update is a read-modify-write and so is racy between concurrent
   * invocations. For one operator driving one conversation that is fine and
   * locking would cost more than it saves; past INDEX_SOFT_LIMIT prospects it
   * would not be, which is what the warning below is for.
   */
  private async save(prospect: Prospect): Promise<void> {
    await this.kv.set(`prospect:${prospect.id}`, prospect);

    const index = await this.listProspects();
    const summary: ProspectSummary = {
      id: prospect.id,
      full_name: prospect.full_name,
      company: prospect.company,
      status: prospect.status,
      sequence_id: prospect.enrollment?.sequence_id,
      step_index: prospect.enrollment?.step_index,
      next_due_at:
        prospect.enrollment && prospect.enrollment.state === "pending"
          ? prospect.enrollment.next_due_at
          : undefined,
      last_touched_at: prospect.last_touched_at,
    };

    const at = index.findIndex((row) => row.id === prospect.id);
    if (at >= 0) index[at] = summary;
    else index.push(summary);

    await this.kv.set("index:prospects", index);
  }

  /** Surfaced by the tools so the operator hears about it before it hurts. */
  async indexPressure(): Promise<{ count: number; limit: number; over: boolean }> {
    const count = (await this.listProspects()).length;
    return { count, limit: INDEX_SOFT_LIMIT, over: count > INDEX_SOFT_LIMIT };
  }
}
