import type { CampaignState, RelativeFreePeriod } from "../types.js";
import { selectGameDescription } from "../game-description.js";

const BUFFER_API_URL = "https://api.buffer.com";
const X_WEIGHTED_LENGTH_LIMIT = 280;
const X_SHORTENED_URL_LENGTH = 23;
const URL_PATTERN = /https?:\/\/[^\s]+/giu;
const POST_TIME_ZONE = "Asia/Tokyo";

export class BufferRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super(
      `Buffer API request failed (HTTP 429); retry after ${new Date(retryAt).toISOString()}`,
    );
    this.name = "BufferRateLimitError";
  }
}

export interface BufferCredentials {
  apiKey: string;
  channelId: string;
}

export interface PaidTransitionPost {
  productId: string;
  title: string;
  storeUrl: string;
  officialDescription?: string;
  tags?: string[];
  notBeforeAt?: string;
  relativeFreePeriod?: RelativeFreePeriod;
}

interface BufferResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export interface RecentBufferPost {
  id: string;
  status: string;
  text: string;
  createdAt?: string;
  sentAt?: string;
  error?:
    | { message: string; supportUrl?: string; rawError?: string | null }
    | null
    | undefined;
}

// Never put the service's raw response (which may contain credentials) in logs.
// Emit only numeric error codes and a fixed vocabulary of diagnostic signals.
export function summarizePublishingError(raw: string | null | undefined) {
  if (!raw) return undefined;
  const codes = [
    ...raw.matchAll(
      /(?:["']?(?:code|status|statusCode)["']?\s*[:=]\s*["']?|HTTP\s+)(\d{2,4})/giu,
    ),
  ].map((match) => Number(match[1]));
  if (/^\d{2,4}$/u.test(raw.trim())) codes.push(Number(raw.trim()));
  const signals = [
    "Could not authenticate you",
    "Invalid or expired token",
    "Invalid token",
    "Unauthorized",
    "Forbidden",
    "Read-only",
    "write permission",
    "locked",
    "suspended",
    "rate limit",
    "Too Many Requests",
    "CreditsDepleted",
    "Payment Required",
    "duplicate",
    "expired",
    "oauth",
    "authentication",
    "authorization",
    "permission",
    "auth",
    "token",
    "credential",
    "access",
    "invalid",
    "denied",
    "disconnect",
    "reauthoriz",
    "not authenticated",
    "expired",
    "invalid_grant",
    "invalid_client",
    "insufficient_scope",
    "[object Object]",
    "EAUTH",
    "ECONNRESET",
    "ETIMEDOUT",
  ].filter((signal) => raw.toLowerCase().includes(signal.toLowerCase()));
  return {
    codes: [...new Set(codes)],
    signals,
    present: true,
    length: raw.length,
    json: /^[\[{]/u.test(raw.trim()),
  };
}

function plainTextWeight(value: string): number {
  let weight = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    // X counts Latin and common punctuation as one. Counting every other code
    // point as two is conservative for Japanese and joined emoji sequences.
    weight += codePoint <= 0x10ff ? 1 : 2;
  }
  return weight;
}

export function xWeightedLength(value: string): number {
  let weight = 0;
  let cursor = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    weight += plainTextWeight(value.slice(cursor, match.index));
    weight += X_SHORTENED_URL_LENGTH;
    cursor = match.index + match[0].length;
  }
  return weight + plainTextWeight(value.slice(cursor));
}

function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(amount / 100);
  } catch {
    return `${currency} ${(amount / 100).toFixed(2)}`;
  }
}

function formatJst(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: POST_TIME_ZONE,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function buildPostText(campaign: CampaignState): string {
  const render = (title: string, description?: string): string => {
    if (campaign.kind === "permanent_free") {
      const lines = [
        "🎮 新作の無料ゲームを発見！",
        "",
        `『${title}』`,
        "✨ いつでも無料でプレイ",
      ];
      if (description) lines.push("", description);
      lines.push("", campaign.storeUrl);
      return lines.join("\n");
    }

    if (campaign.kind === "temporary_play") {
      const lines = [
        "🎮 今だけ無料で遊べる！",
        "",
        `『${title}』`,
        "🆓 期間限定の無料プレイ",
      ];
      if (campaign.startsAt && campaign.endsAt) {
        lines.push(
          `⏰ ${formatJst(campaign.startsAt)}〜${formatJst(campaign.endsAt)}`,
        );
      } else if (campaign.endsAt) {
        lines.push(`⏰ ${formatJst(campaign.endsAt)}まで`);
      } else if (campaign.startsAt) {
        lines.push(`⏰ ${formatJst(campaign.startsAt)}から`);
      }
      if (description) lines.push("", description);
      lines.push(
        "",
        "✨ 気になっていたなら、今がチャンス！",
        campaign.storeUrl,
      );
      return lines.join("\n");
    }

    const lines = [
      "🎁 今だけ無料でもらえる！",
      "",
      `『${title}』`,
      `💰 ${formatPrice(campaign.initialPrice, campaign.currency)} → 無料（100% OFF）`,
    ];
    if (campaign.endsAt) {
      lines.push(`⏰ ${formatJst(campaign.endsAt)}まで`);
    }
    if (description) lines.push("", description);
    lines.push(
      "",
      "✅ 期間内に入手すれば、終了後も遊べます",
      campaign.storeUrl,
    );
    return lines.join("\n");
  };

  let description = selectGameDescription(campaign);
  const complete = render(campaign.title, description);
  if (xWeightedLength(complete) <= X_WEIGHTED_LENGTH_LIMIT) return complete;

  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  if (description) {
    let shortenedDescription = "";
    for (const { segment } of segmenter.segment(description)) {
      if (
        xWeightedLength(
          render(campaign.title, `${shortenedDescription}${segment}…`),
        ) > X_WEIGHTED_LENGTH_LIMIT
      ) {
        break;
      }
      shortenedDescription += segment;
    }
    description = shortenedDescription ? `${shortenedDescription}…` : undefined;
    const shortenedPost = render(campaign.title, description);
    if (xWeightedLength(shortenedPost) <= X_WEIGHTED_LENGTH_LIMIT) {
      return shortenedPost;
    }
  }

  let shortened = "";
  for (const { segment } of segmenter.segment(campaign.title)) {
    if (
      xWeightedLength(render(`${shortened}${segment}…`, description)) >
      X_WEIGHTED_LENGTH_LIMIT
    ) {
      break;
    }
    shortened += segment;
  }
  const result = render(`${shortened}…`, description);
  if (xWeightedLength(result) > X_WEIGHTED_LENGTH_LIMIT) {
    throw new Error("X post template exceeds the weighted character limit");
  }
  return result;
}

export function buildEndingReminderPostText(campaign: CampaignState): string {
  if (!campaign.endsAt) {
    throw new Error("An ending reminder requires a campaign end time");
  }
  const endsAt = campaign.endsAt;

  const render = (title: string, description?: string): string => {
    const campaignType =
      campaign.kind === "temporary_play" ? "無料プレイ" : "無料配布";
    const campaignTypeEmoji = campaign.kind === "temporary_play" ? "🎮" : "🎁";
    const callToAction =
      campaign.kind === "temporary_play"
        ? "🚨 遊ぶなら今！"
        : "🚨 ライブラリへの追加をお忘れなく！";
    const lines = [
      "⏰ 無料期間、まもなく終了！",
      "",
      `『${title}』`,
      `${campaignTypeEmoji} ${campaignType}は ${formatJst(endsAt)}まで`,
    ];
    if (description) lines.push("", description);
    lines.push("", callToAction, campaign.storeUrl);
    return lines.join("\n");
  };

  let description = selectGameDescription(campaign);
  const complete = render(campaign.title, description);
  if (xWeightedLength(complete) <= X_WEIGHTED_LENGTH_LIMIT) return complete;

  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  if (description) {
    let shortenedDescription = "";
    for (const { segment } of segmenter.segment(description)) {
      if (
        xWeightedLength(
          render(campaign.title, `${shortenedDescription}${segment}…`),
        ) > X_WEIGHTED_LENGTH_LIMIT
      ) {
        break;
      }
      shortenedDescription += segment;
    }
    description = shortenedDescription ? `${shortenedDescription}…` : undefined;
    const shortenedPost = render(campaign.title, description);
    if (xWeightedLength(shortenedPost) <= X_WEIGHTED_LENGTH_LIMIT) {
      return shortenedPost;
    }
  }

  let shortened = "";
  for (const { segment } of segmenter.segment(campaign.title)) {
    if (
      xWeightedLength(render(`${shortened}${segment}…`, description)) >
      X_WEIGHTED_LENGTH_LIMIT
    ) {
      break;
    }
    shortened += segment;
  }
  const result = render(`${shortened}…`, description);
  if (xWeightedLength(result) > X_WEIGHTED_LENGTH_LIMIT) {
    throw new Error("Ending-reminder X post exceeds the character limit");
  }
  return result;
}

export function buildPaidTransitionPostText(
  transition: PaidTransitionPost,
): string {
  let statusLine = "現在無料 → 近日中に有料化予定";
  if (transition.relativeFreePeriod) {
    const { amount, unit, anchor } = transition.relativeFreePeriod;
    const unitText =
      unit === "day" ? "日間" : unit === "week" ? "週間" : "か月間";
    const anchorText = anchor === "release" ? "リリース後" : "告知後";
    statusLine = `${anchorText}${amount}${unitText}は無料 → その後有料化予定`;
  } else if (transition.notBeforeAt) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("ja-JP", {
        timeZone: POST_TIME_ZONE,
        month: "numeric",
        day: "numeric",
      })
        .formatToParts(new Date(transition.notBeforeAt))
        .map(({ type, value }) => [type, value]),
    );
    statusLine = `現在無料 → ${parts.month}月${parts.day}日以降に有料化予定`;
  }
  const render = (title: string, description?: string): string => {
    const lines = [
      "⚠️ 無料で入手できるのは今のうち！",
      "",
      `『${title}』`,
      `💰 ${statusLine}`,
    ];
    if (description) lines.push("", description);
    lines.push("", transition.storeUrl);
    return lines.join("\n");
  };
  let description = selectGameDescription(transition);
  const complete = render(transition.title, description);
  if (xWeightedLength(complete) <= X_WEIGHTED_LENGTH_LIMIT) return complete;

  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  if (description) {
    let shortenedDescription = "";
    for (const { segment } of segmenter.segment(description)) {
      if (
        xWeightedLength(
          render(transition.title, `${shortenedDescription}${segment}…`),
        ) > X_WEIGHTED_LENGTH_LIMIT
      ) {
        break;
      }
      shortenedDescription += segment;
    }
    description = shortenedDescription ? `${shortenedDescription}…` : undefined;
    const shortenedPost = render(transition.title, description);
    if (xWeightedLength(shortenedPost) <= X_WEIGHTED_LENGTH_LIMIT) {
      return shortenedPost;
    }
  }

  let shortened = "";
  for (const { segment } of segmenter.segment(transition.title)) {
    if (
      xWeightedLength(render(`${shortened}${segment}…`, description)) >
      X_WEIGHTED_LENGTH_LIMIT
    ) {
      break;
    }
    shortened += segment;
  }
  const result = render(`${shortened}…`, description);
  if (xWeightedLength(result) > X_WEIGHTED_LENGTH_LIMIT) {
    throw new Error(
      "Paid-transition X post exceeds the weighted character limit",
    );
  }
  return result;
}

export class BufferPublisher {
  private retryAt = 0;
  private organizationId: Promise<string> | undefined;
  private recentPosts: Promise<RecentBufferPost[]> | undefined;
  private readonly createdPosts = new Map<string, RecentBufferPost>();

  constructor(
    private readonly credentials: BufferCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async publish(campaign: CampaignState): Promise<{ id: string }> {
    return this.publishText(buildPostText(campaign));
  }

  async inspectDelivery() {
    const channel = await this.request<{
      channel: {
        isDisconnected: boolean;
        isLocked: boolean;
        isQueuePaused: boolean;
      };
    }>(
      `query ChannelHealth($channelId: ChannelId!) {
        channel(input: { id: $channelId }) { isDisconnected isLocked isQueuePaused }
      }`,
      { channelId: this.credentials.channelId },
    );
    const posts = await this.loadRecentPosts(true);
    return {
      channel: channel.channel,
      posts: posts.map(({ id, status, createdAt, sentAt, error }) => ({
        id,
        status,
        createdAt,
        sentAt,
        error: error
          ? {
              message: error.message,
              supportUrl: error.supportUrl,
              upstream: summarizePublishingError(error.rawError),
            }
          : error,
      })),
    };
  }

  async findPost(input: {
    id?: string;
    text: string;
    notBeforeAt: string;
  }): Promise<RecentBufferPost | undefined> {
    // Share the same snapshot (and in-flight request) across this batch.
    this.recentPosts ??= this.loadRecentPosts().catch((error: unknown) => {
      this.recentPosts = undefined;
      throw error;
    });
    const posts = await this.recentPosts;
    return [...this.createdPosts.values(), ...posts].find((post) => {
      if (input.id) return post.id === input.id;
      const createdAt = Date.parse(post.createdAt ?? "");
      return (
        post.text === input.text &&
        Number.isFinite(createdAt) &&
        createdAt >= Date.parse(input.notBeforeAt)
      );
    });
  }

  private async loadOrganizationId(): Promise<string> {
    const channelData = await this.request<{
      channel?: { organizationId?: string };
    }>(
      `
        query ChannelOrganization($channelId: ChannelId!) {
          channel(input: { id: $channelId }) { organizationId }
        }
      `,
      { channelId: this.credentials.channelId },
    );
    const organizationId = channelData.channel?.organizationId;
    if (!organizationId) {
      throw new Error("Buffer channel did not include an organization ID");
    }
    return organizationId;
  }

  private async loadRecentPosts(
    includeRawErrors = false,
  ): Promise<RecentBufferPost[]> {
    this.organizationId ??= this.loadOrganizationId().catch(
      (error: unknown) => {
        this.organizationId = undefined;
        throw error;
      },
    );
    const organizationId = await this.organizationId;

    const postsData = await this.request<{
      posts?: {
        edges?: Array<{
          node?: RecentBufferPost & { channelId?: string };
        }>;
      };
    }>(
      `
        query RecentPosts(
          $organizationId: OrganizationId!
          $channelId: ChannelId!
        ) {
          posts(
            first: 100
            input: {
              organizationId: $organizationId
              sort: [{ field: createdAt, direction: desc }]
              filter: { channelIds: [$channelId] }
            }
          ) {
            edges { node { id status text createdAt sentAt channelId error { message supportUrl ${includeRawErrors ? "rawError" : ""} } } }
          }
        }
      `,
      { organizationId, channelId: this.credentials.channelId },
    );

    return (postsData.posts?.edges ?? [])
      .map((edge) => edge.node)
      .filter(
        (post): post is RecentBufferPost & { channelId?: string } =>
          !!post && post.channelId === this.credentials.channelId,
      );
  }

  async publishText(text: string): Promise<{
    id: string;
    status: string;
    error?: RecentBufferPost["error"];
  }> {
    const createdAt = new Date().toISOString();
    try {
      const data = await this.request<{
        createPost?: {
          __typename: string;
          post?: {
            id: string;
            status: string;
            error?: RecentBufferPost["error"];
          };
          message?: string;
        };
      }>(
        `
        mutation CreatePost($input: CreatePostInput!) {
          createPost(input: $input) {
            __typename
            ... on PostActionSuccess {
              post { id status error { message supportUrl } }
            }
            ... on MutationError { message }
          }
        }
      `,
        {
          input: {
            text,
            channelId: this.credentials.channelId,
            schedulingType: "automatic",
            mode: "shareNow",
          },
        },
      );

      const result = data.createPost;
      if (result?.__typename !== "PostActionSuccess" || !result.post) {
        throw new Error(
          `Buffer rejected the post: ${result?.message ?? result?.__typename ?? "unknown error"}`,
        );
      }
      this.createdPosts.set(result.post.id, {
        ...result.post,
        text,
        createdAt,
      });
      return result.post;
    } catch (error) {
      // A timeout may have created a post. Recovery must consult the server
      // again rather than treating an earlier empty snapshot as authoritative.
      if (!(error instanceof BufferRateLimitError))
        this.recentPosts = undefined;
      throw error;
    }
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    if (this.retryAt > Date.now()) throw new BufferRateLimitError(this.retryAt);
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetchImpl(BUFFER_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credentials.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });

      // Only retry explicit rejections. Timeouts and 5xx mutation responses may
      // have created a post already, so those must retain delivery uncertainty.
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = header?.trim() ? Number(header) : NaN;
        const date = header ? Date.parse(header) : NaN;
        const delay = Number.isFinite(seconds)
          ? Math.max(0, seconds * 1_000)
          : Number.isFinite(date)
            ? Math.max(0, date - Date.now())
            : 1_000 * 2 ** (attempt - 1);
        this.retryAt = Date.now() + delay;
        await response.body?.cancel();
        // Daily/monthly limits cannot be resolved within this job. Preserve the
        // server's deadline and reject further calls without hammering the API.
        if (attempt >= 3 || delay > 60_000)
          throw new BufferRateLimitError(this.retryAt);
        await this.sleep(delay);
        continue;
      }
      this.retryAt = 0;

      let payload: BufferResponse<T>;
      try {
        payload = (await response.json()) as BufferResponse<T>;
      } catch {
        throw new Error(
          `Buffer API returned invalid JSON (HTTP ${response.status})`,
        );
      }

      if (!response.ok) {
        throw new Error(`Buffer API request failed (HTTP ${response.status})`);
      }
      if (payload.errors?.length) {
        throw new Error(
          `Buffer API GraphQL error: ${payload.errors[0]?.message ?? "unknown error"}`,
        );
      }

      if (!payload.data) {
        throw new Error("Buffer API response did not include data");
      }
      return payload.data;
    }
  }
}
