/* Baker 1031 — client proposal print document builder.
   Used by /employee.html. Renders a multi-page 8.5x11 proposal (cover, contents,
   one sheet per portfolio, back cover, page numbers) in the site brand system and
   sends it to the browser's print dialog (Destination: Save as PDF).

   window.B1031Proposal.print(cfg)
   cfg = {
     investor, saleClose, day45, day180, tracking, dateLabel,
     portfolios: [{ name, strategy: "income"|"growth"|"balanced"|"diversified",
                    positions: [{ name, type, page, ltv(%), y1(%|null), avg(%|null), alloc($) }] }]
   }
   Zero-coupon = y1 missing/0: badge, "—" in cash-flow columns, 0% in blends. */
(function () {
  "use strict";

  var CLOUD = "https://res.cloudinary.com/opoazlei/image/upload";
  var LOGO = CLOUD + "/v1783843015/76c3b97b-a853-46f1-bf6f-19285b0754f8_l5pbup.png";
  var HEADSHOT = CLOUD + "/v1783927734/jerry-baker_ovhy2w.jpg";
  var COVER_PHOTOS = [
    CLOUD + "/f_auto,q_auto,w_600/v1783843881/Apartments_pllp0h.jpg",
    CLOUD + "/f_auto,q_auto,w_600/v1783843878/Amazon_q2ru5v.png",
    CLOUD + "/f_auto,q_auto,w_600/v1783843880/Hotel_ojlaau.jpg"
  ];
  var ORIGIN = "https://baker1031.com";

  var BOILER = "Baker 1031 Investments is a San Francisco–based, founder-led real estate securities firm that helps accredited investors complete 1031 exchanges using institutional Delaware Statutory Trust (DST) properties — building custom portfolios from leading sponsors, and also working in 721 UPREIT exchanges, Opportunity Zone funds, mineral &amp; royalty interests, and REITs so clients defer capital gains and own income real estate without the work of managing it.";

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function money(x) { return "$" + Math.round(x).toLocaleString("en-US"); }
  function pct(x, dp) { return x.toFixed(dp === undefined ? 2 : dp) + "%"; }

  function compute(pf) {
    pf.positions.forEach(function (p) {
      p.zc = !p.y1;
      var l = (p.ltv || 0) / 100;
      p.debt = (l > 0 && l < 0.995) ? p.alloc * (l / (1 - l)) : 0;
    });
    pf.equity = pf.positions.reduce(function (s, p) { return s + p.alloc; }, 0);
    pf.debtTot = pf.positions.reduce(function (s, p) { return s + p.debt; }, 0);
    pf.total = pf.equity + pf.debtTot;
    pf.bY1 = pf.positions.reduce(function (s, p) { return s + p.alloc * (p.y1 || 0); }, 0) / pf.equity;
    pf.bAvg = pf.positions.reduce(function (s, p) {
      var v = p.zc ? 0 : (p.avg != null ? p.avg : (p.y1 || 0));
      return s + p.alloc * v;
    }, 0) / pf.equity;
    pf.monthly = pf.equity * pf.bY1 / 100 / 12;
    pf.portLtv = pf.total ? pf.debtTot / pf.total * 100 : 0;
    return pf;
  }

  function whyProse(pf, tier) {
    var n = pf.positions.length;
    var zc = pf.positions.filter(function (p) { return p.zc; });
    var lead = {
      income: "This mix is built to maximize current cash flow. The allocations tilt toward the offerings paying the highest projected distributions, while still spreading the portfolio across sponsors and asset types so no single property, tenant, or market carries the plan.",
      growth: "This mix is built for growth first, current cash flow second. The allocations favor offerings whose projected return comes through appreciation and rising distributions rather than the highest starting yield, spread across sponsors and asset types so no single property or market carries the plan.",
      diversified: "This mix is built for maximum diversification. The allocations reach across as many asset types as the inventory supports, so the portfolio's results depend on many properties, tenants, and markets instead of a few.",
      balanced: "This mix balances current cash flow against growth. The equity is spread across sponsors and asset types so no single property or market carries the plan, with financed and all-cash positions weighed against each other."
    }[pf.strategy] || "This mix spreads the exchange across institutional offerings selected from current inventory.";
    if (n === 1) {
      var goal = { income: "current cash flow", growth: "long-term growth", diversified: "simplicity", balanced: "a balance of current cash flow and growth" }[pf.strategy] || "your goals";
      lead = "This proposal places the full exchange into a single institutional offering, the strongest fit in current inventory for " + goal + ". It keeps the exchange simple: one sponsor, one set of documents, and a clean path to your Day 180 deadline.";
    }
    var debtline = pf.debtTot > 0
      ? " The financed positions are sized so the portfolio's debt replacement lands on the full " + money(pf.debtTot) + "."
      : (n === 1 ? " The position is all-cash: no lender, no loan covenants, and no financing risk."
                 : " Every position is all-cash: no lender, no loan covenants, and no financing risk anywhere in the portfolio.");
    var zcline = "";
    if (zc.length) {
      var names = zc.map(function (p) { return p.name; }).join(", ");
      zcline = " Note that " + names + (zc.length === 1 ? " is a zero-coupon structure" : " are zero-coupon structures") +
        ": it pays no distributions along the way by design, and the projected return arrives as appreciation when the property sells. " +
        "It shows as “—” in the cash-flow columns and is counted at zero in the blended figures, so every cash-flow number on this page is earned by the income-producing positions alone.";
    }
    var closing = " Each trust holds institutional real estate you could not buy alone at this scale, and none of it comes with a tenant phone call. Every figure comes from the sponsor's own materials, and I underwrite each offering before it reaches this page.";
    if (tier.dense) return "<p>" + lead + debtline + zcline + "</p>";
    if (zc.length) return "<p>" + lead + debtline + zcline + "</p><p>Ask me what any of these is paying and I'll walk you through the assumptions behind the number.</p>";
    return "<p>" + lead + debtline + zcline + "</p><p>" + closing + " Ask me what any of these is paying and I'll walk you through the assumptions behind the number.</p>";
  }

  function sheetBody(pf, cfg) {
    var pos = pf.positions, n = pos.length;
    var zc = pos.filter(function (p) { return p.zc; });
    var typeCount = {}; pos.forEach(function (p) { typeCount[p.type] = 1; });
    var types = Object.keys(typeCount).length;
    var tier = n <= 3 ? { tfont: 12, h1: 27, dense: false, whyfont: 12, cls: "tn" }
             : n <= 6 ? { tfont: 11.5, h1: 27, dense: false, whyfont: 11.5, cls: "tn" }
             : n <= 9 ? { tfont: 10, h1: 22, dense: true, whyfont: 10.5, cls: "td" }
                      : { tfont: 9.5, h1: 20, dense: true, whyfont: 10, cls: "tu" };

    var rows = pos.map(function (p) {
      var link = p.page ? '<a href="' + esc(p.page.indexOf("http") === 0 ? p.page : ORIGIN + p.page) + '">' + esc(p.name) + "</a>" : esc(p.name);
      var tag = p.zc ? ' <b class="zctag">Zero-Coupon</b>' : "";
      return "    <tr>\n" +
        '      <td class="name">' + link + tag + "</td>\n" +
        "      <td>" + esc(p.type) + "</td>\n" +
        '      <td class="num">' + (!p.ltv ? "All-Cash" : pct(p.ltv)) + "</td>\n" +
        '      <td class="num">' + (p.zc ? "—" : pct(p.y1)) + '</td><td class="num">' + (p.zc || p.avg == null ? "—" : pct(p.avg)) + "</td>\n" +
        '      <td class="alloc">' + money(p.alloc) + '</td><td class="num">' + (p.debt ? money(p.debt) : "$0") + "</td>\n    </tr>";
    }).join("\n");
    var totalRow = '    <tr class="total"><td>Total</td><td></td>' +
      '<td class="num">' + (pf.debtTot === 0 ? "All-Cash" : pct(pf.portLtv, 1)) + "</td>" +
      '<td class="num">' + pct(pf.bY1) + '</td><td class="num">' + pct(pf.bAvg) + "</td>" +
      '<td class="alloc">' + money(pf.equity) + '</td><td class="num">' + money(pf.debtTot) + "</td></tr>";

    var caption = '<div class="caption">' + n + " position" + (n !== 1 ? "s" : "") + " · " + types + " asset type" + (types !== 1 ? "s" : "") +
      " · " + (pf.debtTot === 0 ? "all-cash" : "blended portfolio LTV " + pct(pf.portLtv, 1)) + "</div>";

    var zcFoot = zc.length ? " Zero-coupon positions pay no current distributions and are included at 0% in blended cash-flow figures." : "";
    var lede = tier.dense ? "" :
      '<p class="lede">Built for an exchange of <strong>' + money(pf.equity) + " in equity</strong> " +
      (pf.debtTot > 0 ? "with <strong>" + money(pf.debtTot) + " of mortgage debt to replace</strong>" : "with <strong>no debt to replace</strong>") +
      " — " + n + " institutional DST position" + (n !== 1 ? "s" : "") + " selected from current inventory.</p>";

    return '\n  <div class="hdr"><img src="' + LOGO + '" alt="Baker 1031 Investments">' +
      '<div class="tag">Tracking Nº<br><span class="code">' + esc(cfg.tracking || "[Tracking Code]") + "</span></div></div>" +
      '\n  <h1 style="font-size:' + tier.h1 + 'px">' + esc(pf.name || "Proposed DST Portfolio") + '<span class="h1dot">.</span></h1>' +
      '\n  <div class="prep">' +
      '<div class="cell"><div class="v">' + esc(cfg.investor || "[Investor Name]") + '</div><div class="k">Prepared For</div></div>' +
      '<div class="cell"><div class="v">' + esc(cfg.saleClose || "[Sale Closing Date]") + '</div><div class="k">Sale Closing</div></div>' +
      '<div class="cell"><div class="v">' + esc(cfg.day45 || "[ID Deadline]") + '</div><div class="k">Day 45 · ID Deadline</div></div>' +
      '<div class="cell"><div class="v">' + esc(cfg.day180 || "[Completion Date]") + '</div><div class="k">Day 180 · Exchange Complete</div></div>' +
      "</div>\n  " + lede +
      '\n  <div class="stats">' +
      '<div class="stat"><div class="n">' + money(pf.equity) + '</div><div class="l">Exchange Equity</div></div>' +
      '<div class="stat"><div class="n">' + money(pf.debtTot) + '</div><div class="l">Debt Replaced</div></div>' +
      '<div class="stat"><div class="n">' + money(pf.total) + '</div><div class="l">Total Portfolio Value</div></div>' +
      '<div class="stat"><div class="n">' + pct(pf.bAvg) + '*</div><div class="l">Avg Cash Flow</div></div>' +
      '<div class="stat"><div class="n">' + money(pf.monthly) + '*</div><div class="l">Est. Monthly · Yr 1</div></div>' +
      "</div>" +
      "\n  <h2>The proposed positions.</h2>" +
      '\n  <table class="' + tier.cls + '" style="font-size:' + tier.tfont + 'px">' +
      '<colgroup><col class="c-name"><col class="c-type"><col class="c-ltv"><col class="c-y1"><col class="c-avg"><col class="c-alloc"><col class="c-debt"></colgroup>' +
      '<tr><th class="name">Offering</th><th>Asset<br>Type</th><th class="num">LTV</th><th class="num">Yr-1<br>Cash Flow*</th><th class="num">Avg<br>Cash Flow*</th><th class="alloc">Allocation</th><th class="num">Debt<br>Replaced</th></tr>\n' +
      rows + "\n" + totalRow + "\n  </table>\n  " + caption +
      '\n  <div class="why" style="margin-top:' + (tier.dense ? 12 : 18) + 'px"><h2 style="margin-top:0">Why this mix.</h2>' +
      '<div class="whyp" style="font-size:' + tier.whyfont + "px;" + (tier.dense ? "column-count:2;column-gap:28px;" : "") + '">' + whyProse(pf, tier) + "</div></div>" +
      '\n  <div class="contactbar"><img src="' + HEADSHOT + '" alt="Jerry Baker">' +
      '<div class="who">Jerry Baker<br><span>Founder &amp; Managing Principal · Baker 1031 Investments</span></div>' +
      '<div class="reach">(415) 579-1660 · <a href="mailto:jerry@baker1031.com">jerry@baker1031.com</a><br>650 California Street, San Francisco, CA 94108</div></div>' +
      '\n  <div class="foot">*Yr-1 cash flow is each sponsor’s projected first-year distribution rate; Avg cash flow is the equity-weighted average of sponsor-projected distribution rates over each offering’s projection period; estimated monthly cash flow is the blended Year-1 rate applied to exchange equity, divided by twelve. Distributions are projections, are not guaranteed, and may be modified or suspended.' + zcFoot +
      " This is a hypothetical illustration for discussion purposes only; it is not a recommendation, an offer to sell, or a solicitation of an offer to buy any security. Offers are made only by a sponsor’s Private Placement Memorandum, which describes material risks, fees, and expenses. DST interests are speculative, illiquid, available to accredited investors only, and involve risk of loss of principal. Offering figures are drawn from sponsor materials as of " + esc(cfg.dateLabel) + " and are subject to change and availability. Securities offered through Aurora Securities, Inc., member FINRA/SIPC. Check the background of this firm at FINRA BrokerCheck (firm CRD 46147).</div>";
  }

  var CSS = "*{margin:0;padding:0;box-sizing:border-box}@page{size:letter;margin:0}" +
    "body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#fff;color:#000}" +
    ".page{width:816px;height:1056px;background:#fff;padding:46px 56px 36px 56px;position:relative;overflow:hidden;page-break-after:always}" +
    ".page:last-child{page-break-after:auto}a{color:#2b3a5f;text-decoration:none}.h1dot{color:#2b3a5f}" +
    ".hdr{display:flex;align-items:flex-start;justify-content:space-between}.hdr img{height:28px}" +
    ".hdr .tag{font-size:8.5px;letter-spacing:0.14em;text-transform:uppercase;color:#4a4a4a;text-align:right;line-height:1.5}" +
    ".hdr .tag .code{font-size:11px;letter-spacing:0.08em;color:#2b3a5f;font-weight:700}" +
    "h1{font-weight:700;letter-spacing:-0.01em;line-height:1.15;margin-top:18px}" +
    ".pgnum{position:absolute;right:56px;bottom:12px;font-size:8px;letter-spacing:0.1em;color:#4a4a4a}" +
    ".kicker{font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#4a4a4a}" +
    ".cv-mid{margin-top:170px}.cv-title{font-size:54px;font-weight:700;letter-spacing:-0.015em;line-height:1.08;color:#2b3a5f;margin-top:16px}" +
    ".cv-for{font-size:17px;margin-top:26px}.cv-date{font-size:11.5px;color:#4a4a4a;margin-top:8px}" +
    ".cv-photos{position:absolute;left:56px;right:56px;bottom:120px;display:flex;gap:10px;height:210px}" +
    ".cv-photos .ph{flex:1;background-size:cover;background-position:center;border-radius:10px}" +
    ".cv-foot{position:absolute;left:56px;right:56px;bottom:40px;border-top:1px solid #e4e4e4;padding-top:12px;font-size:9.5px;letter-spacing:0.08em;text-transform:uppercase;color:#4a4a4a;text-align:center}" +
    ".toc{margin-top:22px;border-top:1px solid #2b3a5f}" +
    ".toc-row{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e4e4e4;padding:16px 2px}" +
    ".toc-name{font-size:15px;font-weight:700;color:#2b3a5f}.toc-sub{font-size:10.5px;color:#4a4a4a;margin-top:3px}" +
    ".toc-pg{font-size:15px;font-weight:700;color:#2b3a5f}.about{font-size:11.5px;line-height:1.6;margin-top:8px}" +
    ".prep{display:flex;justify-content:space-between;border-top:1px solid #e4e4e4;border-bottom:1px solid #e4e4e4;margin-top:14px;padding:9px 2px}" +
    ".prep .cell .v{font-size:12.5px;font-weight:700}.prep .cell .k{font-size:8.5px;letter-spacing:0.12em;text-transform:uppercase;color:#4a4a4a;margin-top:3px}" +
    ".lede{font-size:12px;line-height:1.5;color:#4a4a4a;margin-top:13px}" +
    ".stats{display:flex;justify-content:space-between;border-top:1px solid #e4e4e4;border-bottom:1px solid #e4e4e4;margin-top:12px;padding:11px 2px}" +
    ".stat .n{font-size:19px;font-weight:700;color:#2b3a5f}.stat .l{font-size:9px;letter-spacing:0.11em;text-transform:uppercase;color:#4a4a4a;margin-top:4px}" +
    "h2{font-size:14px;font-weight:700;margin-top:18px}" +
    "table{width:100%;border-collapse:collapse;margin-top:10px;table-layout:fixed}" +
    "table.tn col.c-name{width:236px}table.tn col.c-type{width:92px}table.tn col.c-ltv{width:70px}table.tn col.c-y1{width:72px}table.tn col.c-avg{width:72px}table.tn col.c-alloc{width:82px}table.tn col.c-debt{width:80px}" +
    "table.td col.c-name,table.tu col.c-name{width:300px}table.td col.c-type,table.tu col.c-type{width:70px}table.td col.c-ltv,table.tu col.c-ltv{width:54px}table.td col.c-y1,table.tu col.c-y1{width:64px}table.td col.c-avg,table.tu col.c-avg{width:64px}table.td col.c-alloc,table.tu col.c-alloc{width:78px}table.td col.c-debt,table.tu col.c-debt{width:74px}" +
    "th{font-size:8.5px;letter-spacing:0.08em;text-transform:uppercase;color:#4a4a4a;font-weight:600;padding:0 0 6px 0;border-bottom:1px solid #2b3a5f;text-align:left;line-height:1.3;vertical-align:bottom}" +
    "table.tn td{padding:13px 0}table.td td{padding:8px 0}table.tu td{padding:4.5px 0}" +
    "td{border-bottom:1px solid #e4e4e4;vertical-align:top;line-height:1.3}" +
    "td.num,td.alloc{text-align:right;white-space:nowrap;padding-left:12px}th.num,th.alloc{text-align:right;padding-left:12px}" +
    "td.name,th.name{padding-right:10px}table.tn td.name{font-weight:700;font-size:12px}table.td td.name{font-weight:700;font-size:10.5px}table.tu td.name{font-weight:700;font-size:10px}" +
    "td.name a{color:#2b3a5f;border-bottom:1px solid #c9cfdd}" +
    "b.zctag{display:inline-block;font-size:7.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#2b3a5f;border:1px solid #2b3a5f;border-radius:3px;padding:2px 5px 1px 5px;margin-left:7px;line-height:1;vertical-align:15%}" +
    "td.alloc{font-weight:700;color:#2b3a5f}tr.total td{border-bottom:none;border-top:1px solid #2b3a5f;font-weight:700;padding-top:8px}" +
    ".caption{font-size:9.5px;letter-spacing:0.06em;text-transform:uppercase;color:#4a4a4a;margin-top:8px}" +
    ".whyp p{line-height:1.55;margin-top:7px}" +
    ".contactbar{display:flex;align-items:center;gap:14px;border-top:1px solid #e4e4e4;margin-top:11px;padding-top:8px}" +
    ".contactbar img{width:44px;height:44px;border-radius:50%;object-fit:cover}" +
    ".contactbar .who{font-size:12px;font-weight:700}.contactbar .who span{font-weight:400;color:#4a4a4a}" +
    ".contactbar .reach{margin-left:auto;text-align:right;font-size:11px;line-height:1.5}.contactbar .reach a{font-weight:700}" +
    ".foot{position:absolute;left:56px;right:56px;bottom:26px;border-top:1px solid #e4e4e4;padding-top:8px;font-size:7.4px;line-height:1.42;color:#4a4a4a}" +
    ".page.back{background:#2b3a5f;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
    ".bk-mid{margin-top:330px;text-align:center}.bk-name{font-size:30px;font-weight:700}.bk-name .h1dot{color:#fff}" +
    ".bk-rule{width:56px;height:2px;background:rgba(255,255,255,0.5);margin:22px auto}" +
    ".bk-line{font-size:12.5px;line-height:1.7;color:rgba(255,255,255,0.92)}" +
    ".bk-heart{position:absolute;left:0;right:0;bottom:110px;text-align:center;font-size:44px;font-weight:700;color:rgba(255,255,255,0.10);white-space:nowrap}" +
    ".bk-heart .ht{color:rgba(255,255,255,0.16)}" +
    ".bk-disc{position:absolute;left:56px;right:56px;bottom:34px;border-top:1px solid rgba(255,255,255,0.25);padding-top:10px;font-size:7.6px;line-height:1.5;color:rgba(255,255,255,0.65);text-align:center}";

  function buildDocument(cfg) {
    cfg = cfg || {};
    cfg.dateLabel = cfg.dateLabel || new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
    var pfs = (cfg.portfolios || []).map(function (pf) { return compute(pf); });
    if (!pfs.length) throw new Error("No portfolios to print.");
    var totalPages = pfs.length + 3;
    var track = esc(cfg.tracking || "[Tracking Code]");
    var inv = esc(cfg.investor || "[Investor Name]");
    var pgnum = function (i) { return '<div class="pgnum">' + i + " / " + totalPages + "</div>"; };

    var cover = '<div class="hdr"><img src="' + LOGO + '" alt="Baker 1031 Investments">' +
      '<div class="tag">Tracking Nº<br><span class="code">' + track + "</span></div></div>" +
      '<div class="cv-mid"><div class="kicker">Private Investment Proposal</div>' +
      '<div class="cv-title">DST Portfolio<br>Proposal' + (pfs.length > 1 ? "s" : "") + '<span class="h1dot">.</span></div>' +
      '<div class="cv-for">Prepared for <strong>' + inv + "</strong></div>" +
      '<div class="cv-date">' + esc(cfg.dateLabel) + " · " + pfs.length + " portfolio" + (pfs.length !== 1 ? "s" : "") + " · For discussion only</div></div>" +
      '<div class="cv-photos">' + COVER_PHOTOS.map(function (u) { return '<div class="ph" style="background-image:url(' + u + ')"></div>'; }).join("") + "</div>" +
      '<div class="cv-foot">Baker 1031 Investments · 650 California Street, San Francisco, CA 94108 · baker1031.com</div>';

    var tocRows = pfs.map(function (pf, i) {
      var summary = pf.positions.length + " position" + (pf.positions.length !== 1 ? "s" : "") + " · " + money(pf.equity) + " equity · " +
        (pf.debtTot === 0 ? "all-cash" : money(pf.debtTot) + " debt replaced") + " · " + pct(pf.bAvg) + " avg cash flow";
      return '<div class="toc-row"><div><div class="toc-name">' + esc(pf.name || "Portfolio") + '</div><div class="toc-sub">' + summary + '</div></div><div class="toc-pg">' + (i + 3) + "</div></div>";
    }).join("");
    var toc = '<div class="hdr"><img src="' + LOGO + '" alt="Baker 1031 Investments">' +
      '<div class="tag">Tracking Nº<br><span class="code">' + track + "</span></div></div>" +
      '<h1 style="font-size:27px">Contents<span class="h1dot">.</span></h1>' +
      '<div class="toc">' + tocRows +
      '<div class="toc-row"><div><div class="toc-name">How to reach me</div><div class="toc-sub">Contact and disclosures</div></div><div class="toc-pg">' + totalPages + "</div></div></div>" +
      '<h2 style="margin-top:34px">About Baker 1031 Investments.</h2><p class="about">' + BOILER + "</p>" +
      '<p class="about">Each proposal in this document was built from the same exchange: the equity, debt, and deadline figures shown on every sheet. The mixes differ in what they optimize for, and the sheets are meant to be compared side by side. Every offering listed links to its full detail page, and none of this is final: availability changes daily, and each mix is a starting point for a conversation.</p>' +
      '<div class="foot">This document is a hypothetical illustration for discussion purposes only; it is not a recommendation, an offer to sell, or a solicitation of an offer to buy any security. Offers are made only by a sponsor’s Private Placement Memorandum. DST interests are speculative, illiquid, available to accredited investors only, and involve risk of loss of principal. Securities offered through Aurora Securities, Inc., member FINRA/SIPC.</div>';

    var back = '<div class="bk-mid"><div class="bk-name">Baker 1031 Investments<span class="h1dot">.</span></div>' +
      '<div class="bk-rule"></div>' +
      '<div class="bk-line">Jerry Baker · Founder &amp; Managing Principal</div>' +
      '<div class="bk-line">(415) 579-1660 · jerry@baker1031.com</div>' +
      '<div class="bk-line">650 California Street, San Francisco, CA 94108</div>' +
      '<div class="bk-line" style="margin-top:14px">baker1031.com</div></div>' +
      '<div class="bk-heart">We <span class="ht">♥</span> 1031 Exchanges</div>' +
      '<div class="bk-disc">Securities offered through Aurora Securities, Inc., member FINRA/SIPC. Check the background of this firm at FINRA BrokerCheck (firm CRD 46147). DST interests are speculative, illiquid, available to accredited investors only, and involve risk of loss of principal. Offers are made only by a sponsor’s Private Placement Memorandum. Tracking Nº ' + track + "</div>";

    var pages = ['<div class="page cover">' + cover + "</div>", '<div class="page">' + toc + pgnum(2) + "</div>"];
    pfs.forEach(function (pf, i) { pages.push('<div class="page">' + sheetBody(pf, cfg) + pgnum(i + 3) + "</div>"); });
    pages.push('<div class="page back">' + back + "</div>");

    return "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>Baker 1031 — DST Portfolio Proposal</title><style>" + CSS + "</style></head><body>" + pages.join("\n") + "</body></html>";
  }

  function printDocument(cfg) {
    var html = buildDocument(cfg);
    var frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
    frame.onload = function () {
      var w = frame.contentWindow;
      // wait for images (logo, headshot, cover photos) before opening the dialog
      var imgs = Array.prototype.slice.call(w.document.images);
      var pending = imgs.filter(function (im) { return !im.complete; }).length;
      var done = function () {
        setTimeout(function () {
          w.focus(); w.print();
          setTimeout(function () { document.body.removeChild(frame); }, 60000);
        }, 250);
      };
      if (!pending) return done();
      var left = pending;
      imgs.forEach(function (im) {
        if (im.complete) return;
        im.onload = im.onerror = function () { if (--left <= 0) done(); };
      });
      setTimeout(done, 6000); // never hang on a stuck image
    };
    frame.srcdoc = html;
  }

  window.B1031Proposal = { buildDocument: buildDocument, print: printDocument };
})();
