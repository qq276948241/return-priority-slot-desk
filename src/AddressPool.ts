import {AbstractIPNum, IPv4, IPv6, isIPv4} from "./IPNumber";
import {RangedSet} from "./IPRange";

/**
 * The IP address family: 4 for IPv4, 6 for IPv6.
 */
export type AddressFamily = 4 | 6;

/**
 * Describes an inclusive segment [first, last] that a {@link AddressPool} is built with.
 */
export interface AddressSegmentSpec {
    first: string;
    last: string;
}

/**
 * A segment as it is snapshotted when a pool is built.
 */
export interface AddressSegment {
    first: string;
    last: string;
    startValue: bigint;
    endValue: bigint;
}

/**
 * The result of a successful allocation. It states which family and segment the address came from.
 */
export interface AllocatedAddress {
    address: string;
    family: AddressFamily;
    version: number;
    segment: AddressSegment;
}

export class InvalidAddressError extends Error {
    constructor(address: string) {
        super(`Invalid or unknown IP address: ${address}`);
        this.name = 'InvalidAddressError';
        Object.setPrototypeOf(this, InvalidAddressError.prototype);
    }
}

export class EmptySegmentError extends Error {
    constructor(public readonly family: AddressFamily) {
        super(`The ${family === 4 ? 'IPv4' : 'IPv6'} segment is empty: the first address must not be greater than the last`);
        this.name = 'EmptySegmentError';
        Object.setPrototypeOf(this, EmptySegmentError.prototype);
    }
}

export class PoolEmptyError extends Error {
    constructor(public readonly family: AddressFamily) {
        super(`The ${family === 4 ? 'IPv4' : 'IPv6'} pool is empty`);
        this.name = 'PoolEmptyError';
        Object.setPrototypeOf(this, PoolEmptyError.prototype);
    }
}

export class AddressNotAllocatedError extends Error {
    constructor(public readonly address: string) {
        super(`Address ${address} was never allocated from this pool`);
        this.name = 'AddressNotAllocatedError';
        Object.setPrototypeOf(this, AddressNotAllocatedError.prototype);
    }
}

export class DuplicateReleaseError extends Error {
    constructor(public readonly address: string) {
        super(`Address ${address} has already been released`);
        this.name = 'DuplicateReleaseError';
        Object.setPrototypeOf(this, DuplicateReleaseError.prototype);
    }
}

export class VersionMismatchError extends Error {
    constructor(public readonly address: string,
                public readonly expectedVersion: number,
                public readonly givenVersion: number) {
        super(`Wrong version for ${address}: expected ${expectedVersion} but got ${givenVersion}`);
        this.name = 'VersionMismatchError';
        Object.setPrototypeOf(this, VersionMismatchError.prototype);
    }
}

interface Lease {
    family: AddressFamily;
    segment: AddressSegment;
    version: number;
}

interface FamilyLedger {
    family: AddressFamily;
    segments: AddressSegment[];
    cursor: Map<AddressSegment, bigint>;
    outstanding: Map<bigint, Lease>;
    returned: bigint[];
    versions: Map<bigint, number>;
    everAllocated: Set<bigint>;
}

function parseAddress(address: string): AbstractIPNum {
    let trimmed = address.trim();
    try {
        return new IPv4(trimmed);
    } catch (e4) {
        try {
            return new IPv6(trimmed);
        } catch (e6) {
            throw new InvalidAddressError(address);
        }
    }
}

function familyOf(ip: AbstractIPNum): AddressFamily {
    return isIPv4(ip) ? 4 : 6;
}

function format(ip: AbstractIPNum): string {
    if (isIPv4(ip)) {
        return ip.toString();
    }
    return collapseIPv6(ip as IPv6);
}

function collapseIPv6(ip: IPv6): string {
    let groups: string[] = ip.getHexadecatet().map(group => group.getValue().toString(16));
    let bestStart = -1;
    let bestLength = 0;
    let currentStart = -1;
    let currentLength = 0;
    groups.forEach((group, index) => {
        if (group === '0') {
            if (currentStart === -1) {
                currentStart = index;
                currentLength = 1;
            } else {
                currentLength++;
            }
            if (currentLength > bestLength) {
                bestStart = currentStart;
                bestLength = currentLength;
            }
        } else {
            currentStart = -1;
            currentLength = 0;
        }
    });

    let parts: string[];
    if (bestLength < 2) {
        parts = groups;
    } else {
        let head = groups.slice(0, bestStart);
        let tail = groups.slice(bestStart + bestLength);
        parts = [`${head.join(':')}::${tail.join(':')}`];
    }
    return parts[0];
}

/**
 * A single-ledger address pool that tracks IPv4 and IPv6 allocations separately.
 *
 * Addresses are only ever handed out from a declared segment of the requested family.
 * An address cannot be allocated twice while still outstanding; it must be released
 * first. Releasing an unknown address is rejected and duplicate releases are rejected
 * instead of crediting the quota twice.
 */
export class AddressPool {
    private readonly ledgers: Map<AddressFamily, FamilyLedger> = new Map();

    constructor(public readonly name: string, segments: Array<AddressSegmentSpec | RangedSet<IPv4> | RangedSet<IPv6>>) {
        this.ledgers.set(4, {family: 4, segments: [], cursor: new Map(), outstanding: new Map(), returned: [], versions: new Map(), everAllocated: new Set()});
        this.ledgers.set(6, {family: 6, segments: [], cursor: new Map(), outstanding: new Map(), returned: [], versions: new Map(), everAllocated: new Set()});

        segments.forEach(segment => this.addSegment(segment));
    }

    private addSegment(segment: AddressSegmentSpec | RangedSet<IPv4> | RangedSet<IPv6>) {
        let firstIp: AbstractIPNum;
        let lastIp: AbstractIPNum;
        if (segment instanceof RangedSet) {
            firstIp = segment.getFirst();
            lastIp = segment.getLast();
        } else {
            firstIp = parseAddress(segment.first);
            lastIp = parseAddress(segment.last);
        }

        let family = familyOf(firstIp);
        if (familyOf(lastIp) !== family) {
            throw new EmptySegmentError(family);
        }
        if (firstIp.isGreaterThan(lastIp)) {
            throw new EmptySegmentError(family);
        }

        let snapshotted: AddressSegment = {
            first: format(firstIp),
            last: format(lastIp),
            startValue: firstIp.getValue(),
            endValue: lastIp.getValue()
        };
        let ledger = this.ledgers.get(family)!;
        ledger.segments.push(snapshotted);
        ledger.cursor.set(snapshotted, snapshotted.startValue);
    }

    /**
     * Allocates one address from the requested family.
     *
     * @throws {PoolEmptyError} if the requested family has no free address.
     */
    public allocate(family: AddressFamily): AllocatedAddress {
        return this.commitAllocation(family);
    }

    /**
     * Asynchronously allocates one address. Concurrent requests are serialized, so when
     * two callers race for the last address exactly one succeeds and the loser sees
     * {@link PoolEmptyError}, never an out-of-range address.
     */
    public async allocateAsync(family: AddressFamily): Promise<AllocatedAddress> {
        let previous = this.mutex;
        let release: () => void;
        this.mutex = new Promise<void>(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return this.commitAllocation(family);
        } finally {
            release!();
        }
    }

    private mutex: Promise<void> = Promise.resolve();

    private commitAllocation(family: AddressFamily): AllocatedAddress {
        let ledger = this.ledgers.get(family);
        if (!ledger) {
            throw new PoolEmptyError(family);
        }

        while (ledger.returned.length > 0) {
            let value = ledger.returned.shift()!;
            if (!ledger.outstanding.has(value)) {
                let segment = this.findSegment(ledger, value);
                if (segment !== undefined) {
                    let ip = this.toIp(family, value);
                    return this.recordAllocation(ledger, value, ip, segment, this.nextVersion(ledger, value));
                }
            }
        }

        for (let segment of ledger.segments) {
            let cursor = ledger.cursor.get(segment)!;
            let candidate = cursor;
            while (candidate <= segment.endValue) {
                if (!ledger.outstanding.has(candidate)) {
                    ledger.cursor.set(segment, candidate + 1n);
                    let ip = this.toIp(family, candidate);
                    return this.recordAllocation(ledger, candidate, ip, segment, 0);
                }
                candidate++;
            }
            ledger.cursor.set(segment, candidate);
        }

        throw new PoolEmptyError(family);
    }

    private recordAllocation(ledger: FamilyLedger,
                             value: bigint,
                             ip: AbstractIPNum,
                             segment: AddressSegment,
                             version: number): AllocatedAddress {
        ledger.outstanding.set(value, {family: ledger.family, segment, version});
        ledger.versions.set(value, version);
        ledger.everAllocated.add(value);
        return {address: format(ip), family: ledger.family, version, segment};
    }

    private findSegment(ledger: FamilyLedger, value: bigint): AddressSegment | undefined {
        return ledger.segments.find(segment => value >= segment.startValue && value <= segment.endValue);
    }

    private nextVersion(ledger: FamilyLedger, value: bigint): number {
        let previousVersion = ledger.versions.get(value);
        return previousVersion === undefined ? 0 : previousVersion + 1;
    }

    /**
     * Releases an outstanding address. Releasing an unknown address, releasing twice, or
     * supplying the wrong version all leave the ledger untouched.
     *
     * @throws {AddressNotAllocatedError} if the address was never allocated.
     * @throws {DuplicateReleaseError} if it has already been released.
     * @throws {VersionMismatchError} if the version does not match the outstanding lease.
     */
    public release(address: string, version: number): void {
        let ip = parseAddress(address);
        let family = familyOf(ip);
        let ledger = this.ledgers.get(family)!;
        let value = ip.getValue();
        let lease = ledger.outstanding.get(value);

        if (lease === undefined) {
            if (ledger.everAllocated.has(value)) {
                throw new DuplicateReleaseError(format(ip));
            }
            throw new AddressNotAllocatedError(format(ip));
        }

        if (lease.version !== version) {
            throw new VersionMismatchError(format(ip), lease.version, version);
        }

        ledger.outstanding.delete(value);
        ledger.returned.push(value);
    }

    /**
     * Returns true if the address is currently allocated and not yet released.
     * An out-of-range address, including one numerically adjacent to a segment,
     * returns false; v4 and v6 lookups never cross.
     */
    public isOutstanding(address: string): boolean {
        let ip = parseAddress(address);
        let ledger = this.ledgers.get(familyOf(ip))!;
        return ledger.outstanding.has(ip.getValue());
    }

    /**
     * Returns the outstanding lease record for the address, or undefined if it is not out.
     */
    public getLease(address: string): Lease | undefined {
        let ip = parseAddress(address);
        return this.ledgers.get(familyOf(ip))!.outstanding.get(ip.getValue());
    }

    /**
     * Returns true if the address falls within one of the declared segments of its family.
     */
    public contains(address: string): boolean {
        let ip = parseAddress(address);
        let family = familyOf(ip);
        let value = ip.getValue();
        return this.ledgers.get(family)!.segments
            .some(segment => value >= segment.startValue && value <= segment.endValue);
    }

    /**
     * Returns the remaining (not currently outstanding) address count for the family.
     * v4 and v6 remainders are reported independently.
     */
    public remaining(family: AddressFamily): bigint {
        let ledger = this.ledgers.get(family)!;
        let total = ledger.segments.reduce((sum, segment) => {
            return sum + (segment.endValue - segment.startValue + 1n);
        }, 0n);
        return total - BigInt(ledger.outstanding.size);
    }

    public getSegments(family: AddressFamily): AddressSegment[] {
        return this.ledgers.get(family)!.segments.map(segment => ({...segment}));
    }

    private toIp(family: AddressFamily, value: bigint): AbstractIPNum {
        return family === 4 ? IPv4.fromNumber(value) : IPv6.fromBigInt(value);
    }
}

export class PoolNotExistsError extends Error {
    constructor(public readonly poolName: string) {
        super(`Pool ${poolName} does not exist`);
        this.name = 'PoolNotExistsError';
        Object.setPrototypeOf(this, PoolNotExistsError.prototype);
    }
}

/**
 * A registry of named {@link AddressPool}s, allowing "not built" to be distinguished
 * from "built but empty".
 */
export class PoolRegistry {
    private readonly pools: Map<string, AddressPool> = new Map();

    public create(name: string,
                  segments: Array<AddressSegmentSpec | RangedSet<IPv4> | RangedSet<IPv6>>): AddressPool {
        let pool = new AddressPool(name, segments);
        this.pools.set(name, pool);
        return pool;
    }

    public register(pool: AddressPool): void {
        this.pools.set(pool.name, pool);
    }

    public has(name: string): boolean {
        return this.pools.has(name);
    }

    public get(name: string): AddressPool {
        let pool = this.pools.get(name);
        if (pool === undefined) {
            throw new PoolNotExistsError(name);
        }
        return pool;
    }

    public allocate(name: string, family: AddressFamily): AllocatedAddress {
        return this.get(name).allocate(family);
    }

    public release(name: string, address: string, version: number): void {
        this.get(name).release(address, version);
    }

    public isOutstanding(name: string, address: string): boolean {
        return this.get(name).isOutstanding(address);
    }

    public remaining(name: string, family: AddressFamily): bigint {
        return this.get(name).remaining(family);
    }
}
