import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BufferPublisher } from "../src/publishers/buffer.js";
import { deliverPost } from "../src/delivery.js";
import type { DeliveryState } from "../src/types.js";

function setup() {
  const calls = { organization: 0, history: 0, create: 0 };
  const posts: Array<Record<string, string>> = [];
  let loseResponse = false;
  let failHistory = false;
  const fetchMock: typeof fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ChannelOrganization")) {
      calls.organization++;
      return Response.json({ data: { channel: { organizationId: "org" } } });
    }
    if (query.includes("RecentPosts")) {
      calls.history++;
      if (failHistory) {
        failHistory = false;
        throw new Error("History unavailable");
      }
      return Response.json({
        data: { posts: { edges: posts.map((node) => ({ node })) } },
      });
    }
    calls.create++;
    const post = {
      id: `post-${calls.create}`,
      status: "sent",
      text: variables.input.text,
      createdAt: new Date().toISOString(),
      channelId: "channel",
    };
    posts.push(post);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("Response lost after creation");
    }
    return Response.json({
      data: { createPost: { __typename: "PostActionSuccess", post } },
    });
  };
  return {
    calls,
    publisher: () =>
      new BufferPublisher({ apiKey: "test", channelId: "channel" }, fetchMock),
    loseResponse: () => {
      loseResponse = true;
    },
    failHistory: () => {
      failHistory = true;
    },
  };
}

const record = (): DeliveryState => ({
  status: "pending",
  firstSeenAt: "2026-01-01T00:00:00Z",
});
const persist = async () => {};

describe("Buffer batch history sharing", () => {
  it("delivers ten posts in twelve requests and prevents duplicates within the batch", async () => {
    const mock = setup();
    const client = mock.publisher();
    for (let i = 0; i < 10; i++) {
      assert.equal(
        await deliverPost(client, record(), `announcement-${i}`, persist),
        "sent",
      );
    }
    assert.deepEqual(mock.calls, { organization: 1, history: 1, create: 10 });
    assert.equal(
      await deliverPost(client, record(), "announcement-0", persist),
      "sent",
    );
    assert.deepEqual(mock.calls, { organization: 1, history: 1, create: 10 });
    // A new run must refresh history, including changed delivery statuses.
    await mock
      .publisher()
      .findPost({ text: "announcement-0", notBeforeAt: "2026-01-01" });
    assert.deepEqual(mock.calls, { organization: 2, history: 2, create: 10 });
  });

  it("shares in-flight lookups", async () => {
    const mock = setup();
    const client = mock.publisher();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        client.findPost({ text: `post-${i}`, notBeforeAt: "2026-01-01" }),
      ),
    );
    assert.deepEqual(mock.calls, { organization: 1, history: 1, create: 0 });
  });

  it("refreshes history after an ambiguous creation and recovers without resending", async () => {
    const mock = setup();
    const client = mock.publisher();
    const delivery = record();
    mock.loseResponse();
    await assert.rejects(
      deliverPost(client, delivery, "announcement", persist),
      /Response lost/,
    );
    assert.equal(delivery.status, "uncertain");
    assert.equal(
      await deliverPost(client, delivery, "announcement", persist),
      "sent",
    );
    assert.deepEqual(mock.calls, { organization: 1, history: 2, create: 1 });
  });

  it("does not cache a failed history lookup as an empty result", async () => {
    const mock = setup();
    const client = mock.publisher();
    mock.failHistory();
    await assert.rejects(
      deliverPost(client, record(), "announcement", persist),
      /History unavailable/,
    );
    assert.equal(mock.calls.create, 0);
    await deliverPost(client, record(), "announcement", persist);
    assert.deepEqual(mock.calls, { organization: 1, history: 2, create: 1 });
  });
});
