import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  SteamProvider,
  parseSteamFeaturedCategories,
  extractPromotionEnd,
  extractSteamTags,
  parseSteamSearchHtml,
  validateTemporaryPlayStoreItem,
  validateSteamAppDetails,
  validateSteamSearchResponse,
} from "../src/providers/steam.js";

describe("Steam promotion parsing", () => {
  it("keeps only app rows with a 100% discount and a previous price", () => {
    const html = `
      <a class="search_result_row" data-ds-appid="100" href="https://store.steampowered.com/app/100/Test_Game/?snr=1">
        <span class="title">Test Game</span>
        <div class="discount_pct">-100%</div>
        <div class="discount_original_price">¥1,200</div>
        <div class="discount_final_price">無料</div>
      </a>
      <a class="search_result_row" data-ds-appid="200" href="https://store.steampowered.com/app/200/F2P/">
        <span class="title">F2P</span>
        <div class="discount_final_price">無料</div>
      </a>`;

    assert.deepEqual(parseSteamSearchHtml(html), [
      {
        kind: "free_to_keep",
        appId: "100",
        title: "Test Game",
        storeUrl: "https://store.steampowered.com/app/100/",
        initialPriceText: "¥1,200",
        finalPriceText: "無料",
        discountPercent: 100,
      },
    ]);
  });

  it("keeps paid games from the temporary-play search without requiring a 100% discount", () => {
    const html = `
      <a class="search_result_row" data-ds-appid="300" href="https://store.steampowered.com/app/300/Temporary/">
        <span class="title">Temporary Play Game</span>
        <div class="search_price">¥2,000</div>
      </a>`;

    assert.deepEqual(parseSteamSearchHtml(html, "temporary_play"), [
      {
        kind: "temporary_play",
        appId: "300",
        title: "Temporary Play Game",
        storeUrl: "https://store.steampowered.com/app/300/",
        initialPriceText: "",
        finalPriceText: "",
        discountPercent: 0,
      },
    ]);
  });

  it("rejects permanent free games during detail validation", () => {
    assert.equal(
      validateSteamAppDetails(
        "100",
        {
          type: "game",
          name: "Permanent F2P",
          is_free: true,
          price_overview: {
            currency: "JPY",
            initial: 0,
            final: 0,
            discount_percent: 0,
          },
        },
        "Fallback",
        "https://store.steampowered.com/app/100/",
      ),
      undefined,
    );
  });

  it("accepts a permanently free game without a price as its own kind", () => {
    const promotion = validateSteamAppDetails(
      "200",
      {
        type: "game",
        name: "New Free Game",
        is_free: true,
        short_description: "Free forever.",
      },
      "Fallback",
      "https://store.steampowered.com/app/200/",
      "permanent_free",
    );

    assert.equal(promotion?.kind, "permanent_free");
    assert.equal(promotion?.initialPrice, 0);
    assert.equal(promotion?.discountPercent, 0);
    assert.equal(promotion?.officialDescription, "Free forever.");
  });

  it("does not mistake a paid title with a separate free license for permanently free", () => {
    assert.equal(
      validateSteamAppDetails(
        "201",
        {
          type: "game",
          name: "Paid Game",
          is_free: true,
          price_overview: {
            currency: "JPY",
            initial: 120000,
            final: 120000,
            discount_percent: 0,
          },
        },
        "Fallback",
        "https://store.steampowered.com/app/201/",
        "permanent_free",
      ),
      undefined,
    );
  });

  it("accepts a paid game discounted to zero", () => {
    const promotion = validateSteamAppDetails(
      "100",
      {
        type: "game",
        name: "Promo Game",
        short_description: "  A <b>friendly</b> game.\n ",
        is_free: false,
        price_overview: {
          currency: "JPY",
          initial: 120000,
          final: 0,
          discount_percent: 100,
        },
      },
      "Fallback",
      "https://store.steampowered.com/app/100/",
    );
    assert.equal(promotion?.productId, "100");
    assert.equal(promotion?.title, "Promo Game");
    assert.equal(promotion?.kind, "free_to_keep");
    assert.equal(promotion?.officialDescription, "A friendly game.");
  });

  it("extracts and deduplicates localized store tags", () => {
    assert.deepEqual(
      extractSteamTags(`
        <div class="glance_tags popular_tags">
          <a class="app_tag"> 心温まる </a>
          <a class="app_tag">会話重視</a>
          <a class="app_tag">心温まる</a>
        </div>`),
      ["心温まる", "会話重視"],
    );
  });

  it("accepts a paid game listed for temporary free play", () => {
    const promotion = validateSteamAppDetails(
      "300",
      {
        type: "game",
        name: "Temporary Play Game",
        is_free: false,
        price_overview: {
          currency: "JPY",
          initial: 200000,
          final: 100000,
          discount_percent: 50,
        },
      },
      "Fallback",
      "https://store.steampowered.com/app/300/",
      "temporary_play",
    );
    assert.equal(promotion?.kind, "temporary_play");
    assert.equal(promotion?.discountPercent, 50);
  });

  it("rejects permanently free games from the temporary-play search", () => {
    assert.equal(
      validateSteamAppDetails(
        "400",
        {
          type: "game",
          name: "Permanent F2P",
          is_free: true,
          price_overview: {
            currency: "JPY",
            initial: 0,
            final: 0,
            discount_percent: 0,
          },
        },
        "Fallback",
        "https://store.steampowered.com/app/400/",
        "temporary_play",
      ),
      undefined,
    );
  });

  it("extracts an exposed promotion deadline", () => {
    assert.equal(
      extractPromotionEnd(
        '<div class="game_area_purchase_game" id="game_area_purchase_section_add_to_cart_100" data-discount-expiration="1791417600">',
        ["100"],
      ),
      "2026-10-08T00:00:00.000Z",
    );
  });

  it("validates Steam's temporary-play flag and extracts its deadline", () => {
    assert.deepEqual(
      validateTemporaryPlayStoreItem(
        {
          is_free_temporarily: true,
          free_weekend: {
            start_time: 1791158400,
            end_time: 1791417600,
          },
        },
        Date.parse("2026-10-06T00:00:00Z"),
      ),
      {
        startsAt: "2026-10-05T00:00:00.000Z",
        endsAt: "2026-10-08T00:00:00.000Z",
      },
    );
    assert.equal(validateTemporaryPlayStoreItem({}), undefined);
  });

  it("rejects malformed search responses and validates a healthy probe", () => {
    assert.throws(
      () => validateSteamSearchResponse({ success: 0 }),
      /did not return a successful response/u,
    );
    assert.deepEqual(
      validateSteamSearchResponse(
        {
          success: 1,
          total_count: 1,
          results_html: '<a class="search_result_row"></a>',
        },
        true,
      ),
      { total: 1, html: '<a class="search_result_row"></a>' },
    );
  });
});

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/steam/${name}`, import.meta.url), "utf8");

describe("real Steam promotional packages and free weekends", () => {
  it("accepts Pony Island's separate free license only with matching permanent retention evidence", () => {
    const details = JSON.parse(fixture("pony-details.json"))["405640"].data;
    const html = fixture("pony-license.html");
    const validate = (data = details, page = html) =>
      validateSteamAppDetails(
        "405640",
        data,
        "Pony Island",
        "https://store.steampowered.com/app/405640/",
        "free_to_keep",
        page,
      );
    assert.equal(validate()?.discountPercent, 100);
    assert.equal(validate(details, ""), undefined);
    assert.equal(
      validate(details, html.replaceAll("1857153", "999999")),
      undefined,
    );
    assert.equal(
      validate(
        details,
        html.replace("今後も無料でキープできる", "期間中だけ遊べる"),
      ),
      undefined,
    );
    assert.equal(validate({ ...details, type: "dlc" }), undefined);
    assert.equal(
      validate({
        ...details,
        price_overview: { ...details.price_overview, initial: 0 },
      }),
      undefined,
    );
    assert.equal(validate({ ...details, package_groups: [] }), undefined);
  });

  it("finds paid and undiscounted free-weekend candidates without relying on marketing language", () => {
    const candidates = parseSteamFeaturedCategories(
      JSON.parse(fixture("featured.json")),
    );
    assert.ok(candidates.some((c) => c.appId === "1621690"));
    const rows = parseSteamFeaturedCategories({
      spotlight: {
        id: "cat_spotlight",
        items: [
          {
            url: "https://store.steampowered.com/app/123/",
            name: "Any language",
          },
          { url: "https://store.steampowered.com/sub/123/" },
        ],
      },
      specials: {
        id: "cat_specials",
        items: [
          { id: 123, type: 0 },
          { id: 999, type: 1 },
        ],
      },
    });
    assert.deepEqual(
      rows.map((c) => c.appId),
      ["123"],
    );
    assert.throws(
      () => parseSteamFeaturedCategories({}),
      /missing promotion categories/u,
    );
  });

  it("rejects scheduled, expired and malformed free weekends", () => {
    const item = JSON.parse(fixture("core-browse.json")).response
      .store_items[0];
    const now = Date.parse("2026-10-09T12:00:00Z");
    assert.ok(validateTemporaryPlayStoreItem(item, now));
    assert.equal(
      validateTemporaryPlayStoreItem(item, Date.parse("2026-10-08T00:00:00Z")),
      undefined,
    );
    assert.equal(
      validateTemporaryPlayStoreItem(item, Date.parse("2026-10-13T00:00:00Z")),
      undefined,
    );
    assert.equal(
      validateTemporaryPlayStoreItem({ free_weekend: {} }, now),
      undefined,
    );
    assert.equal(validateTemporaryPlayStoreItem({}, now), undefined);
  });

  it("does not interpret nonzero prices containing zero as free", () => {
    const html = fixture("pony-search.html").replace(
      /(<div class="discount_final_price">)\s*¥0/u,
      "$1¥1,000",
    );
    assert.deepEqual(parseSteamSearchHtml(html), []);
  });

  it("detects both real campaigns through scan and rejects ordinary featured sales", async (t) => {
    const requests: URL[] = [];
    const core = JSON.parse(fixture("core-browse.json"));
    // Keep the recorded shape, while moving the period around execution time.
    core.response.store_items[0].free_weekend = {
      start_time: Math.floor(Date.now() / 1000) - 60,
      end_time: Math.floor(Date.now() / 1000) + 3600,
    };
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(String(input));
      requests.push(url);
      if (
        url.pathname === "/search/results/" &&
        url.searchParams.get("sort_by") === "Released_DESC"
      )
        return Response.json({
          success: 1,
          total_count: 1,
          results_html:
            '<a class="search_result_row" data-ds-appid="777" href="https://store.steampowered.com/app/777/"><span class="title">New Free Game</span><div class="discount_final_price">無料</div></a>',
        });
      if (url.pathname === "/search/results/")
        return Response.json({
          success: 1,
          total_count: 1,
          results_html: fixture("pony-search.html"),
        });
      if (url.pathname === "/api/featuredcategories")
        return Response.json({
          spotlight: {
            id: "cat_spotlight",
            items: [
              { url: "https://store.steampowered.com/app/1621690/" },
              { url: "https://store.steampowered.com/app/42/" },
            ],
          },
        });
      if (url.pathname === "/api/appdetails") {
        const id = url.searchParams.get("appids");
        if (id === "405640")
          return Response.json(JSON.parse(fixture("pony-details.json")));
        if (id === "1621690")
          return Response.json(JSON.parse(fixture("core-details.json")));
        if (id === "777")
          return Response.json({
            "777": {
              success: true,
              data: {
                type: "game",
                name: "New Free Game",
                is_free: true,
              },
            },
          });
        return Response.json({
          "42": {
            success: true,
            data: {
              type: "game",
              is_free: false,
              price_overview: {
                initial: 10000,
                final: 5000,
                discount_percent: 50,
              },
            },
          },
        });
      }
      if (url.pathname === "/app/405640/")
        return new Response(fixture("pony-license.html"));
      if (url.pathname === "/app/1621690/")
        return new Response(
          '<div class="glance_tags"><a class="app_tag">探索</a><a class="app_tag">サンドボックス</a></div>',
        );
      if (url.pathname === "/app/777/") return new Response("");
      if (url.pathname === "/app/42/") return new Response("");
      if (url.pathname === "/IStoreBrowseService/GetItems/v1/") {
        const appId = JSON.parse(url.searchParams.get("input_json")!).ids[0]
          .appid;
        return Response.json(
          appId === 1621690 ? core : { response: { store_items: [{}] } },
        );
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const result = await new SteamProvider("JP", "japanese").scan();
    assert.deepEqual(
      result.promotions.map((p) => [p.productId, p.kind]),
      [
        ["405640", "free_to_keep"],
        ["777", "permanent_free"],
        ["1621690", "temporary_play"],
      ],
    );
    assert.equal(result.excluded, 1);
    assert.deepEqual(result.errors, []);
    const temporaryPlay = result.promotions.find(
      (promotion) => promotion.kind === "temporary_play",
    );
    assert.ok(temporaryPlay?.endsAt);
    assert.deepEqual(temporaryPlay?.tags, ["探索", "サンドボックス"]);
    assert.ok(
      requests.some(
        (url) =>
          url.pathname === "/api/featuredcategories" &&
          !url.searchParams.has("maxprice"),
      ),
    );
    assert.ok(
      requests.some(
        (url) =>
          url.pathname === "/search/results/" &&
          url.searchParams.get("sort_by") === "Released_DESC" &&
          !url.searchParams.has("specials"),
      ),
    );
  });

  it("pages through every release since the overlap cutoff", async (t) => {
    const permanentStarts: number[] = [];
    const paidRow =
      '<a class="search_result_row" data-ds-appid="100" href="https://store.steampowered.com/app/100/"><span class="title">Paid Promo</span><div class="discount_pct">-100%</div><div class="discount_original_price">¥100</div><div class="discount_final_price">無料</div></a>';
    const freeRow = (id: string, date: string) =>
      `<a class="search_result_row" data-ds-appid="${id}" href="https://store.steampowered.com/app/${id}/"><span class="title">Free ${id}</span><div class="search_released">${date}</div><div class="discount_final_price">Free</div></a>`;

    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(String(input));
      if (
        url.pathname === "/search/results/" &&
        url.searchParams.get("sort_by") === "Released_DESC"
      ) {
        const start = Number(url.searchParams.get("start"));
        permanentStarts.push(start);
        return Response.json({
          success: 1,
          total_count: 101,
          results_html:
            start === 0
              ? freeRow("777", "14 Oct, 2026")
              : freeRow("778", "1 Oct, 2026"),
        });
      }
      if (url.pathname === "/search/results/")
        return Response.json({
          success: 1,
          total_count: 1,
          results_html: paidRow,
        });
      if (url.pathname === "/api/featuredcategories")
        return Response.json({ specials: { id: "cat_specials", items: [] } });
      if (url.pathname === "/api/appdetails")
        return Response.json({
          "100": {
            success: true,
            data: {
              type: "game",
              is_free: false,
              price_overview: {
                currency: "JPY",
                initial: 10000,
                final: 0,
                discount_percent: 100,
              },
            },
          },
        });
      if (url.pathname === "/app/100/") return new Response("");
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await new SteamProvider("JP", "japanese").scan({
      permanentFreeSince: "2026-10-13T00:00:00Z",
      knownPermanentFreeIds: new Set(["777", "778"]),
    });

    assert.deepEqual(permanentStarts, [0, 50]);
    assert.deepEqual(result.permanentFreeCandidateIds, ["777", "778"]);
    assert.equal(result.permanentFreeSourceHealthy, true);
  });

  it("keeps limited promotions when permanent-free discovery fails", async (t) => {
    const paidRow =
      '<a class="search_result_row" data-ds-appid="100" href="https://store.steampowered.com/app/100/"><span class="title">Paid Promo</span><div class="discount_pct">-100%</div><div class="discount_original_price">¥100</div><div class="discount_final_price">無料</div></a>';
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(String(input));
      if (
        url.pathname === "/search/results/" &&
        url.searchParams.get("sort_by") === "Released_DESC"
      )
        return new Response("unavailable", { status: 400 });
      if (url.pathname === "/search/results/")
        return Response.json({
          success: 1,
          total_count: 1,
          results_html: paidRow,
        });
      if (url.pathname === "/api/featuredcategories")
        return Response.json({ specials: { id: "cat_specials", items: [] } });
      if (url.pathname === "/api/appdetails")
        return Response.json({
          "100": {
            success: true,
            data: {
              type: "game",
              is_free: false,
              price_overview: {
                currency: "JPY",
                initial: 10000,
                final: 0,
                discount_percent: 100,
              },
            },
          },
        });
      if (url.pathname === "/app/100/") return new Response("");
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await new SteamProvider("JP", "japanese").scan();

    assert.deepEqual(
      result.promotions.map((promotion) => promotion.productId),
      ["100"],
    );
    assert.equal(result.permanentFreeSourceHealthy, false);
    assert.equal(result.sourceHealthy, false);
  });
});
