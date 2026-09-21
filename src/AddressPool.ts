import {IPv4, IPv6} from "./IPNumber";

/**
 * The address family a pool slot belongs to. IPv4 ("四号段") and IPv6 ("六号段")
 * are tracked in separate ledgers and can never occupy each other's slots.
 */
export type AddressFamily = "IPv4" | "IPv6";

/**
 * Bounds of a declared segment. Both {@link start} and {@link end} are inclusive,
 * so a segment of a single address is declared with start === end.
 */
export class AddressSegment {
    constructor(public readonly family: AddressFamily,
                public readonly start: bigint,
                public readonly end: bigint) {
        if (start > end) {
            throw new EmptySegmentError(family, start, end);
        }
    }

    public contains(value: bigint): boolean {
        return value >= this.start && value <= this.end;
    }

    public getSize(): bigint {
        return this.end - this.start + 1n;
    }
}

/**
 * Describes a segment using address strings, e.g. {start: "10.0.0.1", end: "10.0.0.254"}
 * or {start: "2001:db8::", end: "2001:db8::ffff"}.
 */
export interface SegmentSpec {
    start: string;
    end: string;
}

/**
 * Result of a successful allocation. {@link version} is the current ledger version
 * of the slot and must be presented unchanged when releasing the address.
 */
export interface Allocation {
    family: AddressFamily;
    address: IPv4 | IPv6;
    segment: AddressSegment;
    version: number;
}

interface SlotRecord {
    family: AddressFamily;
    value: bigint;
    segment: AddressSegment;
    version: number;
    outstanding: boolean;
}

export class AddressPoolError extends Error {
    public readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "AddressPoolError";
        this.code = code;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Thrown when an operation references a pool that was never created.
 * Distinct from an existing pool that has no free address.
 */
export class PoolNotFoundError extends AddressPoolError {
    constructor(public readonly poolName: string) {
        super("POOL_NOT_FOUND", `地址池不存在（未建立）: ${poolName}`);
        this.name = "PoolNotFoundError";
        Object.setPrototypeOf(this, PoolNotFoundError.prototype);
    }
}

/**
 * Thrown at pool creation time when a declared segment is empty (start > end).
 */
export class EmptySegmentError extends AddressPoolError {
    constructor(public readonly family: AddressFamily,
                public readonly start: bigint,
                public readonly end: bigint) {
        super("EMPTY_SEGMENT", `段为空: ${family} 段 [${start}, ${end}] 的起地址大于止地址`);
        this.name = "EmptySegmentError";
        Object.setPrototypeOf(this, EmptySegmentError.prototype);
    }
}

/**
 * Thrown when a pool exists but the requested family has no allocatable address.
 * An exhausted IPv4 pool never falls back to IPv6 (and vice versa).
 */
export class PoolExhaustedError extends AddressPoolError {
    constructor(public readonly family: AddressFamily) {
        super("POOL_EXHAUSTED", `地址池已空: ${family} 段没有可发放的地址`);
        this.name = "PoolExhaustedError";
        Object.setPrototypeOf(this, PoolExhaustedError.prototype);
    }
}

/**
 * Thrown when releasing an address the ledger has never handed out.
 */
export class AddressNotAllocatedError extends AddressPoolError {
    constructor(public readonly family: AddressFamily, public readonly address: string) {
        super("ADDRESS_NOT_ALLOCATED", `地址从未发放，拒绝归还: ${address}`);
        this.name = "AddressNotAllocatedError";
        Object.setPrototypeOf(this, AddressNotAllocatedError.prototype);
    }
}

/**
 * Thrown when releasing an address with a stale version. The ledger is left
 * untouched and {@link expectedVersion} states the version currently recorded.
 */
export class VersionMismatchError extends AddressPoolError {
    constructor(public readonly address: string,
                public readonly expectedVersion: number,
                public readonly actualVersion: number) {
        super("VERSION_MISMATCH",
            `版本不对，期望版本 ${expectedVersion}，收到版本 ${actualVersion}，账目未变动`);
        this.name = "VersionMismatchError";
        Object.setPrototypeOf(this, VersionMismatchError.prototype);
    }
}

function parseAddress(family: AddressFamily, address: string): IPv4 | IPv6 {
    if (family === "IPv4") {
        return IPv4.fromDecimalDottedString(address);
    }
    return IPv6.fromString(address);
}

function tryParseValue(family: AddressFamily, address: string): bigint | null {
    try {
        return parseAddress(family, address).getValue();
    } catch (e) {
        return null;
    }
}

function slotKey(family: AddressFamily, value: bigint): string {
    return `${family === "IPv4" ? "4" : "6"}:${value.toString()}`;
}

/**
 * A single ledger ("一本账") for one named address pool. Allocations, releases,
 * outstanding records and remaining counts all live here, with IPv4 and IPv6
 * kept in strictly separate families.
 */
export class AddressPool {
    private segments: { [key in AddressFamily]: Array<AddressSegment> } = {
        IPv4: [],
        IPv6: []
    };
    private readonly slots: Map<string, SlotRecord> = new Map();
    private readonly returned: { [key in AddressFamily]: Array<bigint> } = {
        IPv4: [],
        IPv6: []
    };
    private queues: { [key in AddressFamily]: Promise<unknown> } = {
        IPv4: Promise.resolve(),
        IPv6: Promise.resolve()
    };

    constructor(public readonly name: string, spec: {
        IPv4?: Array<SegmentSpec>;
        IPv6?: Array<SegmentSpec>;
    }) {
        if (spec.IPv4) {
            this.segments.IPv4 = this.toSegments("IPv4", spec.IPv4);
        }
        if (spec.IPv6) {
            this.segments.IPv6 = this.toSegments("IPv6", spec.IPv6);
        }
    }

    private toSegments(family: AddressFamily, specs: Array<SegmentSpec>): Array<AddressSegment> {
        return specs.map(segmentSpec => {
            let start = parseAddress(family, segmentSpec.start).getValue();
            let end = parseAddress(family, segmentSpec.end).getValue();
            return new AddressSegment(family, start, end);
        });
    }

    /**
     * Replaces the declared bounds of a family after the pool has been built.
     * Addresses already outstanding are unaffected; only free space changes.
     */
    public setSegments(family: AddressFamily, specs: Array<SegmentSpec>): void {
        let next = this.toSegments(family, specs);
        this.segments[family] = next;
        this.returned[family] = this.returned[family].filter(value =>
            next.some(segment => segment.contains(value)));
    }

    public getSegments(family: AddressFamily): Array<AddressSegment> {
        return this.segments[family].slice();
    }

    /**
     * Allocates one address from the named family. Recently returned addresses
     * are handed out first (LIFO) to make reconciliation easy. Throws
     * {@link PoolExhaustedError} when no free address exists in the family.
     */
    public allocate(family: AddressFamily): Allocation {
        while (this.returned[family].length > 0) {
            let value = this.returned[family].pop()!;
            let record = this.slots.get(slotKey(family, value));
            if (!record || record.outstanding) {
                continue;
            }
            if (!this.segments[family].some(segment => segment.contains(value))) {
                continue;
            }
            return this.markAllocated(record);
        }

        for (let segment of this.segments[family]) {
            for (let value = segment.start; value <= segment.end; value = value + 1n) {
                let key = slotKey(family, value);
                let existing = this.slots.get(key);
                if (existing && existing.outstanding) {
                    continue;
                }
                if (existing) {
                    return this.markAllocated(existing);
                }
                let record: SlotRecord = {
                    family,
                    value,
                    segment,
                    version: 0,
                    outstanding: false
                };
                this.slots.set(key, record);
                return this.markAllocated(record);
            }
        }

        throw new PoolExhaustedError(family);
    }

    private markAllocated(record: SlotRecord): Allocation {
        record.outstanding = true;
        record.version = record.version + 1;
        return {
            family: record.family,
            address: this.toAddress(record.family, record.value),
            segment: record.segment,
            version: record.version
        };
    }

    /**
     * Serialized allocation: concurrent callers competing for the last slot are
     * queued, so exactly one succeeds and the rest see the pool as exhausted.
     */
    public acquire(family: AddressFamily): Promise<Allocation> {
        let run = this.queues[family].then(() => this.allocate(family));
        this.queues[family] = run.catch(() => undefined);
        return run;
    }

    /**
     * Releases an address back to the pool. The version must match the one
     * handed out at allocation; otherwise the ledger is left untouched.
     */
    public release(family: AddressFamily, address: string, version: number): void {
        let value = parseAddress(family, address).getValue();
        let record = this.slots.get(slotKey(family, value));
        if (!record) {
            throw new AddressNotAllocatedError(family, address);
        }
        if (!record.outstanding || record.version !== version) {
            throw new VersionMismatchError(address, record.version, version);
        }
        record.outstanding = false;
        record.version = record.version + 1;
        if (this.segments[family].some(segment => segment.contains(value))) {
            this.returned[family].push(value);
        }
    }

    /**
     * Returns whether the address is currently checked out. An address just
     * released answers false, and an address outside any segment can never
     * answer true, even if numerically adjacent to the end address.
     */
    public isOutstanding(family: AddressFamily, address: string): boolean {
        let value = tryParseValue(family, address);
        if (value === null) {
            return false;
        }
        let record = this.slots.get(slotKey(family, value));
        return !!record && record.outstanding;
    }

    /**
     * Returns the segment snapshot an outstanding address was issued from.
     * Issued addresses always answer as contained, even if the bounds change
     * afterwards. Returns null for addresses not outstanding.
     */
    public issuedSegment(family: AddressFamily, address: string): AddressSegment | null {
        let value = tryParseValue(family, address);
        if (value === null) {
            return null;
        }
        let record = this.slots.get(slotKey(family, value));
        if (record && record.outstanding && record.segment.contains(value)) {
            return record.segment;
        }
        return null;
    }

    public contains(family: AddressFamily, address: string): boolean {
        let value = tryParseValue(family, address);
        if (value === null) {
            return false;
        }
        return this.segments[family].some(segment => segment.contains(value));
    }

    /**
     * Returns the number of allocatable addresses remaining in one family.
     * IPv4 and IPv6 remainders are always reported separately.
     */
    public remaining(family: AddressFamily): bigint {
        let capacity = this.segments[family].reduce((sum, segment) => sum + segment.getSize(), 0n);
        let outstandingWithinBounds = 0n;
        for (let record of this.slots.values()) {
            if (record.family === family && record.outstanding &&
                this.segments[family].some(segment => segment.contains(record.value))) {
                outstandingWithinBounds = outstandingWithinBounds + 1n;
            }
        }
        return capacity - outstandingWithinBounds;
    }

    private toAddress(family: AddressFamily, value: bigint): IPv4 | IPv6 {
        if (family === "IPv4") {
            return IPv4.fromNumber(value);
        }
        return IPv6.fromBigInt(value);
    }
}

/**
 * Registry of named pools. Operations on a name that was never created fail
 * with {@link PoolNotFoundError}, which is distinct from an existing but
 * exhausted pool.
 */
export class AddressPoolRegistry {
    private readonly pools: Map<string, AddressPool> = new Map();

    public create(name: string, spec: {
        IPv4?: Array<SegmentSpec>;
        IPv6?: Array<SegmentSpec>;
    }): AddressPool {
        let pool = new AddressPool(name, spec);
        this.pools.set(name, pool);
        return pool;
    }

    public exists(name: string): boolean {
        return this.pools.has(name);
    }

    public get(name: string): AddressPool {
        let pool = this.pools.get(name);
        if (!pool) {
            throw new PoolNotFoundError(name);
        }
        return pool;
    }
}
