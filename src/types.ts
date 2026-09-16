/** Shapes that cross module boundaries. Rows mirror schema.sql exactly. */

export type RoomStatus = 'running' | 'paused';
export type TaskState =
  | 'pending_enrich' | 'enriched' | 'awaiting_review' | 'done' | 'failed';
export type Decision = 'approved' | 'edited' | 'skipped';
export type MemberKind = 'human' | 'agent';

export interface Room {
  id: string;
  objective: string;
  icp: string;
  status: RoomStatus;
  searched_at: Date | null;
  next_search_at: Date;
  search_attempts: number;
  last_error: string | null;
  created_at: Date;
}

export interface Task {
  id: string;
  room_id: string;
  person_key: string;
  person: ApolloSearchPerson;
  state: TaskState;
  enrichment: ApolloPerson | null;
  draft: string | null;
  decision: Decision | null;
  linkedin_headline: string | null;
  claimed_by: string | null;
  claim_expires_at: Date | null;
  version: number;
  attempts: number;
  next_run_at: Date;
  last_error: string | null;
  updated_at: Date;
  created_at: Date;
}

export interface RoomMember {
  room_id: string;
  name: string;
  kind: MemberKind;
  joined_at: Date;
}

/** Apollo responses. Only the fields this project actually reads are modelled; the raw
 *  payload carries far more and is stored whole in jsonb. */
export interface ApolloOrganization {
  id?: string;
  name?: string;
  website_url?: string | null;
}

export interface ApolloSearchPerson {
  id: string;
  first_name?: string;
  last_name_obfuscated?: string;
  title?: string;
  organization?: ApolloOrganization | null;
}

export interface ApolloEmploymentEntry {
  title?: string | null;
  organization_name?: string | null;
  current?: boolean | null;
}

export interface ApolloPerson {
  id: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string | null;
  headline?: string | null;
  email?: string | null;
  linkedin_url?: string | null;
  organization?: ApolloOrganization | null;
  employment_history?: ApolloEmploymentEntry[];
}

/** Apollo people-search filters produced from a free-text ICP. */
export interface IcpParams {
  person_titles?: string[];
  person_locations?: string[];
  q_organization_keyword_tags?: string[];
  organization_num_employees_ranges?: string[];
  q_keywords?: string;
}

export interface StepResult<T> {
  output: T;
  cached: boolean;
}

/** What the draft step commits to the ledger. */
export interface DraftShape {
  note: string;
  via: string;
}
