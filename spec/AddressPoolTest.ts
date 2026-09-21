import {
    AddressPool,
    AddressPoolRegistry,
    AddressNotAllocatedError,
    EmptySegmentError,
    PoolExhaustedError,
    PoolNotFoundError,
    VersionMismatchError
} from "../src";

function v4Pool(): AddressPool {
    return new AddressPool("v4", {IPv4: [{start: "10.0.0.1", end: "10.0.0.3"}]});
}

describe('AddressPool 地址池台账', () => {

    it('单地址池：取走再归还后还能再取到同一个地址', () => {
        let pool = new AddressPool("one", {IPv4: [{start: "10.0.0.1", end: "10.0.0.1"}]});

        let first = pool.allocate("IPv4");
        expect(first.address.toString()).toEqual("10.0.0.1");
        expect(() => pool.allocate("IPv4")).toThrowError(PoolExhaustedError);

        pool.release("IPv4", "10.0.0.1", first.version);
        let second = pool.allocate("IPv4");
        expect(second.address.toString()).toEqual("10.0.0.1");
    });

    it('发放落在声明的段内，并能说明来自哪一段；起地址和止地址都能发', () => {
        let pool = v4Pool();

        let start = pool.allocate("IPv4");
        expect(start.address.toString()).toEqual("10.0.0.1");
        expect(start.address.toString() >= "10.0.0.1").toBe(true);
        expect(start.segment.contains(start.address.getValue())).toBe(true);
        expect(start.segment.family).toEqual("IPv4");

        pool.allocate("IPv4");
        let end = pool.allocate("IPv4");
        expect(end.address.toString()).toEqual("10.0.0.3");
        expect(end.segment.contains(end.address.getValue())).toBe(true);
    });

    it('取走未归还的地址不会重复发；发完止地址再取才算空', () => {
        let pool = v4Pool();
        let taken = new Set<string>();
        for (let i = 0; i < 3; i++) {
            taken.add(pool.allocate("IPv4").address.toString());
        }
        expect(taken.size).toEqual(3);
        expect(pool.remaining("IPv4")).toEqual(0n);
        expect(() => pool.allocate("IPv4")).toThrowError(PoolExhaustedError);
    });

    it('不看段的顺序重复发第一个：多段时顺序跳过已取走的', () => {
        let pool = new AddressPool("multi", {
            IPv4: [
                {start: "192.168.0.1", end: "192.168.0.1"},
                {start: "10.0.0.1", end: "10.0.0.2"}
            ]
        });
        let first = pool.allocate("IPv4");
        let second = pool.allocate("IPv4");
        expect(first.address.toString()).toEqual("192.168.0.1");
        expect(second.address.toString()).toEqual("10.0.0.1");
    });

    it('空池再取要停住报空，绝不返回段外地址凑数', () => {
        let pool = new AddressPool("empty", {IPv4: [{start: "10.0.0.1", end: "10.0.0.1"}]});
        pool.allocate("IPv4");
        let threw = false;
        try {
            pool.allocate("IPv4");
        } catch (e) {
            threw = true;
            expect(e instanceof PoolExhaustedError).toBe(true);
        }
        expect(threw).toBe(true);
    });

    it('四号池空了不能从六号池借，且四号六号不互占坑', () => {
        let pool = new AddressPool("both", {
            IPv4: [{start: "10.0.0.1", end: "10.0.0.1"}],
            IPv6: [{start: "2001:db8::1", end: "2001:db8::2"}]
        });
        pool.allocate("IPv4");
        expect(() => pool.allocate("IPv4")).toThrowError(PoolExhaustedError);

        let six = pool.allocate("IPv6");
        expect(six.family).toEqual("IPv6");
        expect(six.address.toString()).toEqual("2001:db8:0:0:0:0:0:1");

        expect(pool.remaining("IPv4")).toEqual(0n);
        expect(pool.remaining("IPv6")).toEqual(1n);
    });

    it('四号和六号剩余分开报，不加在一起；全在外面时剩余为零', () => {
        let pool = new AddressPool("both", {
            IPv4: [{start: "10.0.0.1", end: "10.0.0.1"}],
            IPv6: [{start: "2001:db8::1", end: "2001:db8::1"}]
        });
        expect(pool.remaining("IPv4")).toEqual(1n);
        expect(pool.remaining("IPv6")).toEqual(1n);

        pool.allocate("IPv4");
        pool.allocate("IPv6");
        expect(pool.remaining("IPv4")).toEqual(0n);
        expect(pool.remaining("IPv6")).toEqual(0n);
    });

    it('归还从没发过的地址要拒绝', () => {
        let pool = v4Pool();
        expect(() => pool.release("IPv4", "10.0.0.2", 1))
            .toThrowError(AddressNotAllocatedError);
        expect(pool.remaining("IPv4")).toEqual(3n);
    });

    it('重复归还要报出，名额不加两次', () => {
        let pool = v4Pool();
        let allocation = pool.allocate("IPv4");
        pool.release("IPv4", "10.0.0.1", allocation.version);
        expect(pool.remaining("IPv4")).toEqual(3n);

        expect(() => pool.release("IPv4", "10.0.0.1", allocation.version))
            .toThrowError(VersionMismatchError);
        expect(pool.remaining("IPv4")).toEqual(3n);
    });

    it('归还后下一次发放优先把刚归还的发走', () => {
        let pool = v4Pool();
        let first = pool.allocate("IPv4");
        pool.allocate("IPv4");
        pool.release("IPv4", first.address.toString(), first.version);

        let next = pool.allocate("IPv4");
        expect(next.address.toString()).toEqual(first.address.toString());
    });

    it('归还版本不对，账不动，并指出期望版本', () => {
        let pool = v4Pool();
        let allocation = pool.allocate("IPv4");
        try {
            pool.release("IPv4", "10.0.0.1", allocation.version + 5);
            fail("应当因版本不符抛错");
        } catch (e) {
            expect(e instanceof VersionMismatchError).toBe(true);
            let error = e as VersionMismatchError;
            expect(error.expectedVersion).toEqual(allocation.version);
            expect(error.actualVersion).toEqual(allocation.version + 5);
        }
        expect(pool.isOutstanding("IPv4", "10.0.0.1")).toBe(true);
        expect(pool.remaining("IPv4")).toEqual(2n);
    });

    it('发放记录可按地址查是否在外面，归还后变为不在外面', () => {
        let pool = v4Pool();
        let allocation = pool.allocate("IPv4");
        expect(pool.isOutstanding("IPv4", "10.0.0.1")).toBe(true);

        pool.release("IPv4", "10.0.0.1", allocation.version);
        expect(pool.isOutstanding("IPv4", "10.0.0.1")).toBe(false);
    });

    it('段外地址即使数值上挨着止地址，也不能查成已发放', () => {
        let pool = new AddressPool("edge", {IPv4: [{start: "10.0.0.1", end: "10.0.0.3"}]});
        pool.allocate("IPv4");
        expect(pool.isOutstanding("IPv4", "10.0.0.4")).toBe(false);
        expect(pool.isOutstanding("IPv4", "10.0.0.0")).toBe(false);
    });

    it('四号和六号的查询结果不能串', () => {
        let pool = new AddressPool("both", {
            IPv4: [{start: "10.0.0.1", end: "10.0.0.1"}],
            IPv6: [{start: "2001:db8::1", end: "2001:db8::1"}]
        });
        pool.allocate("IPv4");
        pool.allocate("IPv6");
        expect(pool.isOutstanding("IPv4", "10.0.0.1")).toBe(true);
        expect(pool.isOutstanding("IPv6", "2001:db8::1")).toBe(true);
        expect(pool.isOutstanding("IPv6", "10.0.0.1")).toBe(false);
        expect(pool.isOutstanding("IPv4", "2001:db8::1")).toBe(false);
    });

    it('发出去的地址再问包含，必须在（发放时快照）段内；改段不影响未归还的', () => {
        let pool = new AddressPool("snap", {IPv4: [{start: "10.0.0.1", end: "10.0.0.5"}]});
        let allocation = pool.allocate("IPv4");
        expect(pool.issuedSegment("IPv4", "10.0.0.1")).not.toBeNull();

        pool.setSegments("IPv4", [{start: "192.168.0.1", end: "192.168.0.5"}]);
        expect(allocation.segment.contains(allocation.address.getValue())).toBe(true);
        expect(pool.isOutstanding("IPv4", "10.0.0.1")).toBe(true);
        expect(pool.issuedSegment("IPv4", "10.0.0.1")).not.toBeNull();
        expect(pool.contains("IPv4", "10.0.0.1")).toBe(false);
        expect(pool.contains("IPv4", "192.168.0.1")).toBe(true);
        expect(pool.remaining("IPv4")).toEqual(5n);
    });

    it('空池与段本身为空分开报：建立时段为空立即失败', () => {
        expect(() => new AddressPool("bad", {
            IPv4: [{start: "10.0.0.10", end: "10.0.0.1"}]
        })).toThrowError(EmptySegmentError);

        let pool = new AddressPool("nofamily", {});
        expect(() => pool.allocate("IPv4")).toThrowError(PoolExhaustedError);
    });

    it('六号池折叠形式和展开形式算同一个名额', () => {
        let pool = new AddressPool("six", {
            IPv6: [{start: "2001:db8::1", end: "2001:db8::1"}]
        });
        let allocation = pool.allocate("IPv6");
        expect(allocation.address.toString()).toEqual("2001:db8:0:0:0:0:0:1");
        expect(pool.isOutstanding("IPv6", "2001:db8::1")).toBe(true);
        expect(pool.isOutstanding("IPv6", "2001:db8:0:0:0:0:0:1")).toBe(true);

        pool.release("IPv6", "2001:db8:0:0:0:0:0:1", allocation.version);
        expect(pool.isOutstanding("IPv6", "2001:db8::1")).toBe(false);
    });

    it('并发取同一个最后名额，只有一路成功，失败的一路看到空池', async () => {
        let pool = new AddressPool("race", {IPv4: [{start: "10.0.0.1", end: "10.0.0.1"}]});
        let results = await Promise.allSettled([
            pool.acquire("IPv4"),
            pool.acquire("IPv4")
        ]);
        let fulfilled = results.filter(r => r.status === "fulfilled");
        let rejected = results.filter(r => r.status === "rejected");
        expect(fulfilled.length).toEqual(1);
        expect(rejected.length).toEqual(1);
        let reason = (rejected[0] as PromiseRejectedResult).reason;
        expect(reason instanceof PoolExhaustedError).toBe(true);
        expect(pool.remaining("IPv4")).toEqual(0n);
    });

    it('归还后剩余加一与删除在外面记录同时发生', () => {
        let pool = v4Pool();
        let allocation = pool.allocate("IPv4");
        expect(pool.remaining("IPv4")).toEqual(2n);
        expect(pool.isOutstanding("IPv4", "10.0.0.1")).toBe(true);

        pool.release("IPv4", "10.0.0.1", allocation.version);
        expect(pool.remaining("IPv4")).toEqual(3n);
        expect(pool.isOutstanding("IPv4", "10.0.0.1")).toBe(false);
    });

    it('注册表区分空池与未建池：未建时发放先报没有这个池', () => {
        let registry = new AddressPoolRegistry();
        expect(registry.exists("nope")).toBe(false);
        expect(() => registry.get("nope")).toThrowError(PoolNotFoundError);

        let pool = registry.create("yes", {IPv4: [{start: "10.0.0.1", end: "10.0.0.1"}]});
        pool.allocate("IPv4");
        expect(() => pool.allocate("IPv4")).toThrowError(PoolExhaustedError);
        expect(registry.get("yes")).toBe(pool);
    });
});
