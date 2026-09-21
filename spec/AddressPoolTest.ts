import {
    AddressPool,
    AddressNotAllocatedError,
    DuplicateReleaseError,
    PoolEmptyError,
    EmptySegmentError,
    InvalidAddressError,
    PoolNotExistsError,
    PoolRegistry,
    VersionMismatchError
} from "../src";
import {IPv4, IPv6, RangedSet} from "../src";

describe('AddressPool', () => {
    it('should allocate an in-range address and report its family/segment, then release and re-allocate', () => {
        let pool = new AddressPool('p', [{first: '10.0.0.1', last: '10.0.0.1'}]);

        let first = pool.allocate(4);
        expect(first.address).toEqual('10.0.0.1');
        expect(first.family).toEqual(4);
        expect(first.segment.first).toEqual('10.0.0.1');
        expect(first.segment.last).toEqual('10.0.0.1');
        expect(pool.remaining(4)).toEqual(0n);

        expect(pool.isOutstanding('10.0.0.1')).toBeTrue();
        pool.release('10.0.0.1', first.version);
        expect(pool.isOutstanding('10.0.0.1')).toBeFalse();
        expect(pool.remaining(4)).toEqual(1n);

        let second = pool.allocate(4);
        expect(second.address).toEqual('10.0.0.1');
    });

    it('should keep v4 and v6 ledgers separate and never borrow across families', () => {
        let pool = new AddressPool('p', [
            {first: '10.0.0.1', last: '10.0.0.1'},
            {first: '2001:db8::1', last: '2001:db8::2'}
        ]);

        let v4 = pool.allocate(4);
        expect(v4.address).toEqual('10.0.0.1');

        expect(() => pool.allocate(4)).toThrowError(PoolEmptyError);

        let v6a = pool.allocate(6);
        let v6b = pool.allocate(6);
        expect(v6a.family).toEqual(6);
        expect(v6b.family).toEqual(6);
        expect(v6a.address).not.toEqual(v6b.address);
        expect(() => pool.allocate(6)).toThrowError(PoolEmptyError);

        expect(pool.remaining(4)).toEqual(0n);
        expect(pool.remaining(6)).toEqual(0n);
        pool.release(v4.address, v4.version);
        expect(pool.remaining(4)).toEqual(1n);
        expect(pool.remaining(6)).toEqual(0n);
    });

    it('should reject duplicate release without double crediting the quota', () => {
        let pool = new AddressPool('p', [{first: '10.0.0.1', last: '10.0.0.2'}]);
        let alloc = pool.allocate(4);
        pool.release(alloc.address, alloc.version);

        expect(() => pool.release(alloc.address, alloc.version)).toThrowError(DuplicateReleaseError);
        expect(pool.remaining(4)).toEqual(2n);
    });

    it('should reject release of an address that was never allocated', () => {
        let pool = new AddressPool('p', [{first: '10.0.0.1', last: '10.0.0.2'}]);
        expect(() => pool.release('10.0.0.1', 0)).toThrowError(AddressNotAllocatedError);
        expect(() => pool.release('10.0.0.99', 0)).toThrowError(AddressNotAllocatedError);
        expect(pool.remaining(4)).toEqual(2n);
    });

    it('should reject release with wrong version and leave the ledger untouched, stating expected version', () => {
        let pool = new AddressPool('p', [{first: '10.0.0.1', last: '10.0.0.1'}]);
        let alloc = pool.allocate(4);

        expect(() => pool.release(alloc.address, alloc.version + 1)).toThrowError(VersionMismatchError);
        expect(pool.remaining(4)).toEqual(0n);
        expect(pool.isOutstanding(alloc.address)).toBeTrue();

        try {
            pool.release(alloc.address, alloc.version + 1);
            fail('should have thrown');
        } catch (e) {
            expect(e instanceof VersionMismatchError).toBeTrue();
            expect((e as VersionMismatchError).expectedVersion).toEqual(alloc.version);
        }

        pool.release(alloc.address, alloc.version);
        let next = pool.allocate(4);
        expect(next.version).toEqual(1);
        expect(() => pool.release(next.address, alloc.version)).toThrowError(VersionMismatchError);
        pool.release(next.address, next.version);
    });

    it('should stop on an empty family and never hand out an out-of-range address', () => {
        let pool = new AddressPool('p', [{first: '10.0.0.1', last: '10.0.0.1'}]);
        pool.allocate(4);

        try {
            pool.allocate(4);
            fail('should have thrown');
        } catch (e) {
            expect(e instanceof PoolEmptyError).toBeTrue();
            expect((e as PoolEmptyError).family).toEqual(4);
        }

        expect(() => pool.allocate(6)).toThrowError(PoolEmptyError);
    });

    it('should distinguish an empty segment from an empty pool at construction time', () => {
        expect(() => new AddressPool('p', [{first: '10.0.0.1', last: '10.0.0.0'}]))
            .toThrowError(EmptySegmentError);

        let pool = new AddressPool('p', [{first: '2001:db8::1', last: '2001:db8::1'}]);
        expect(() => pool.allocate(4)).toThrowError(PoolEmptyError);
        expect(pool.remaining(4)).toEqual(0n);
        expect(pool.remaining(6)).toEqual(1n);
    });

    it('should include the first and last address of a segment, and report empty only after the last is taken', () => {
        let pool = new AddressPool('p', [{first: '192.0.2.0', last: '192.0.2.2'}]);

        let first = pool.allocate(4);
        expect(first.address).toEqual('192.0.2.0');
        pool.allocate(4);
        let last = pool.allocate(4);
        expect(last.address).toEqual('192.0.2.2');

        expect(pool.remaining(4)).toEqual(0n);
        expect(() => pool.allocate(4)).toThrowError(PoolEmptyError);
    });

    it('should skip already-taken addresses and not repeatedly allocate the first address', () => {
        let pool = new AddressPool('p', [{first: '10.1.0.0', last: '10.1.0.3'}]);
        let a = pool.allocate(4);
        let b = pool.allocate(4);
        let c = pool.allocate(4);
        expect([a.address, b.address, c.address]).toEqual(['10.1.0.0', '10.1.0.1', '10.1.0.2']);
    });

    it('should prioritize the just-released address on the next allocation', () => {
        let pool = new AddressPool('p', [{first: '10.2.0.0', last: '10.2.0.4'}]);
        let first = pool.allocate(4);
        pool.allocate(4);
        pool.release(first.address, first.version);

        let next = pool.allocate(4);
        expect(next.address).toEqual(first.address);
    });

    it('should treat collapsed and expanded IPv6 forms as the same quota', () => {
        let pool = new AddressPool('p', [{first: '2001:0db8:0000:0000:0000:0000:0000:0001', last: '2001:db8::1'}]);
        let alloc = pool.allocate(6);
        expect(alloc.address).toEqual('2001:db8::1');

        expect(pool.isOutstanding('2001:0db8:0000:0000:0000:0000:0000:0001')).toBeTrue();
        expect(pool.isOutstanding('2001:db8::1')).toBeTrue();

        pool.release('2001:0db8::1', alloc.version);
        expect(pool.isOutstanding('2001:db8:0:0:0:0:0:1')).toBeFalse();
        expect(pool.remaining(6)).toEqual(1n);
    });

    it('should treat allocated addresses as contained, and reject out-of-range neighbours as outstanding', () => {
        let pool = new AddressPool('p', [{first: '10.0.0.1', last: '10.0.0.1'}]);
        let alloc = pool.allocate(4);

        expect(pool.contains('10.0.0.1')).toBeTrue();
        expect(pool.contains('10.0.0.2')).toBeFalse();
        expect(pool.isOutstanding('10.0.0.1')).toBeTrue();
        expect(pool.isOutstanding('10.0.0.2')).toBeFalse();

        pool.release(alloc.address, alloc.version);
        expect(pool.contains('10.0.0.1')).toBeTrue();
        expect(pool.isOutstanding('10.0.0.1')).toBeFalse();
    });

    it('should not cross v4/v6 outstanding queries', () => {
        let pool = new AddressPool('p', [
            {first: '10.0.0.1', last: '10.0.0.1'},
            {first: '2001:db8::1', last: '2001:db8::1'}
        ]);
        pool.allocate(4);
        expect(pool.isOutstanding('10.0.0.1')).toBeTrue();
        expect(pool.isOutstanding('2001:db8::1')).toBeFalse();

        let v6 = pool.allocate(6);
        expect(pool.isOutstanding('2001:db8::1')).toBeTrue();
        pool.release(v6.address, v6.version);
        expect(pool.isOutstanding('2001:db8::1')).toBeFalse();
        expect(pool.isOutstanding('10.0.0.1')).toBeTrue();
    });

    it('should snapshot segment bounds at construction so later edits do not affect outstanding addresses', () => {
        let spec = {first: '10.0.0.1', last: '10.0.0.2'};
        let pool = new AddressPool('p', [spec]);
        let alloc = pool.allocate(4);

        spec.first = '10.0.0.9';
        spec.last = '10.0.0.10';

        expect(pool.contains('10.0.0.1')).toBeTrue();
        expect(pool.contains('10.0.0.9')).toBeFalse();
        expect(pool.isOutstanding(alloc.address)).toBeTrue();
        pool.release(alloc.address, alloc.version);
        expect(pool.remaining(4)).toEqual(2n);
    });

    it('should accept RangedSet segments and invalid addresses clearly', () => {
        let range = new RangedSet(new IPv4('10.5.0.1'), new IPv4('10.5.0.1'));
        let pool = new AddressPool('p', [range]);
        expect(pool.allocate(4).address).toEqual('10.5.0.1');

        expect(() => pool.contains('not-an-ip')).toThrowError(InvalidAddressError);
        expect(() => pool.isOutstanding('not-an-ip')).toThrowError(InvalidAddressError);
    });

    it('should support multiple disjoint segments of the same family', () => {
        let pool = new AddressPool('p', [
            {first: '10.0.0.1', last: '10.0.0.1'},
            {first: '10.0.0.10', last: '10.0.0.11'}
        ]);
        expect(pool.remaining(4)).toEqual(3n);
        expect(pool.allocate(4).address).toEqual('10.0.0.1');
        expect(pool.allocate(4).address).toEqual('10.0.0.10');
        expect(pool.allocate(4).address).toEqual('10.0.0.11');
        expect(() => pool.allocate(4)).toThrowError(PoolEmptyError);
    });

    it('should serialize concurrent requests so only one of two last-quota callers succeeds', async () => {
        let pool = new AddressPool('p', [{first: '10.0.0.1', last: '10.0.0.1'}]);

        let results = await Promise.allSettled([pool.allocateAsync(4), pool.allocateAsync(4)]);
        let fulfilled = results.filter(r => r.status === 'fulfilled');
        let rejected = results.filter(r => r.status === 'rejected');

        expect(fulfilled.length).toEqual(1);
        expect(rejected.length).toEqual(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PoolEmptyError);
        expect(pool.remaining(4)).toEqual(0n);
    });

    it('should atomically increment remaining together with removing the outstanding entry', () => {
        let pool = new AddressPool('p', [{first: '10.0.0.1', last: '10.0.0.1'}]);
        let alloc = pool.allocate(4);
        expect(pool.isOutstanding(alloc.address)).toBeTrue();

        pool.release(alloc.address, alloc.version);

        expect(pool.isOutstanding(alloc.address)).toBeFalse();
        expect(pool.remaining(4)).toEqual(1n);
    });
});

describe('PoolRegistry', () => {
    it('should distinguish not-built from empty, and build-time fail on empty segments', () => {
        let registry = new PoolRegistry();

        expect(registry.has('nope')).toBeFalse();
        expect(() => registry.get('nope')).toThrowError(PoolNotExistsError);
        expect(() => registry.allocate('nope', 4)).toThrowError(PoolNotExistsError);

        registry.create('p', [{first: '10.0.0.1', last: '10.0.0.1'}]);
        expect(registry.has('p')).toBeTrue();

        expect(registry.allocate('p', 4).address).toEqual('10.0.0.1');
        expect(() => registry.allocate('p', 4)).toThrowError(PoolEmptyError);

        expect(() => registry.create('bad', [{first: '10.0.0.1', last: '10.0.0.0'}]))
            .toThrowError(EmptySegmentError);
        expect(registry.has('bad')).toBeFalse();
    });
});
