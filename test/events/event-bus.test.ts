import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { EventBus } from "../../src/events/index.js";

describe("EventBus", () => {
  it("delivers typed events synchronously in subscription order", () => {
    const bus = new EventBus();
    const calls: string[] = [];

    bus.subscribe("phase", (event) => {
      expectTypeOf(event.phase).toEqualTypeOf<
        "preparing" | "planning" | "executing" | "verifying" | "repairing"
      >();
      calls.push(`first:${event.phase}`);
    });
    bus.subscribe("phase", (event) => calls.push(`second:${event.phase}`));

    bus.emit({ type: "phase", phase: "planning" });

    expect(calls).toEqual(["first:planning", "second:planning"]);
  });

  it("supports explicit and returned unsubscribe operations", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("message", listener);

    bus.emit({ type: "message", content: "one" });
    unsubscribe();
    bus.emit({ type: "message", content: "two" });
    bus.subscribe("message", listener);
    bus.unsubscribe("message", listener);
    bus.emit({ type: "message", content: "three" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: "message", content: "one" });
  });

  it("isolates event types and tolerates subscription changes during emit", () => {
    const bus = new EventBus();
    const messageListener = vi.fn();
    const lateListener = vi.fn();

    bus.subscribe("phase", () => {
      bus.subscribe("phase", lateListener);
    });
    bus.subscribe("message", messageListener);

    bus.emit({ type: "phase", phase: "executing" });
    expect(messageListener).not.toHaveBeenCalled();
    expect(lateListener).not.toHaveBeenCalled();

    bus.emit({ type: "phase", phase: "verifying" });
    expect(lateListener).toHaveBeenCalledOnce();
  });
});
