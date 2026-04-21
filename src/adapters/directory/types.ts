/**
 * Directory — pluggable member/booking data source.
 *
 * A community has some notion of "who's here, who's coming, who's going."
 * For Feÿ that's the FeyOps SQLite DB + Amenitiz PMS sync. For a smaller
 * deployment it might just be the `workspace/people/*.md` files. For a
 * Discord-only symbient it might not have bookings at all.
 *
 * The framework exposes this narrow interface so tools like `check_bookings`
 * and `lookup_person` don't hardcode a specific data source. `Booking` and
 * `Member` are loose shapes — adapters may include extra fields.
 */

export interface Member {
  slug: string;           // canonical id (e.g. "aaron-mayer")
  name: string;
  phone?: string;
  signalUuid?: string;
  /** Free-form additional fields (e.g. status, from, field). */
  [key: string]: unknown;
}

export interface Booking {
  id: string | number;
  guest: string;
  room?: string;
  venue?: string;
  checkin: string;    // ISO date
  checkout: string;   // ISO date
  status?: string;
  /** Adapter-specific fields allowed. */
  [key: string]: unknown;
}

export interface Directory {
  readonly name: string;

  /** Find a member by name (fuzzy match). Returns null if not found. */
  findByName(name: string): Promise<Member | null>;

  /** Find a member by phone. Returns null if not found. */
  findByPhone(phone: string): Promise<Member | null>;

  /** List all members. May be expensive — callers should paginate/filter themselves. */
  listMembers?(): Promise<Member[]>;

  /** Bookings filtered by date range (inclusive ISO strings). */
  getBookings(from?: string, to?: string): Promise<Booking[]>;

  /** Convenience: guests currently on-site for the given ISO date. */
  currentGuests(onDate: string): Promise<Booking[]>;

  /** Convenience: guests arriving on the given date. */
  arrivalsOn(date: string): Promise<Booking[]>;

  /** Convenience: guests departing on the given date. */
  departuresOn(date: string): Promise<Booking[]>;
}

export interface DirectoryFactory {
  name: string;
  create(params: Record<string, unknown>): Directory | Promise<Directory>;
}
