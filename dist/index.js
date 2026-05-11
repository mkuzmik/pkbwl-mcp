import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
const BASE_URL = "https://pkbwl.gov.pl";
const REPORTS_API = `${BASE_URL}/api/pkbwl_reports/v1/reports`;
const HEADERS = {
    "Accept": "*/*",
    "Cookie": "pll_language=pl",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15",
    "Referer": `${BASE_URL}/rejestr-zdarzen/`,
};
// ─── Helpers ─────────────────────────────────────────────────────────────────
let reportsCache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
async function fetchAllReports() {
    if (reportsCache && Date.now() - cacheTime < CACHE_TTL_MS) {
        return reportsCache;
    }
    const res = await fetch(REPORTS_API, { headers: HEADERS });
    if (!res.ok)
        throw new Error(`API error: ${res.status}`);
    reportsCache = await res.json();
    cacheTime = Date.now();
    return reportsCache;
}
function normalizeFlag(val) {
    return val.toUpperCase().startsWith("TAK");
}
function reportIdToSlug(id) {
    // Support both "2020/3377" and "2020-3377" formats
    return id.replace("/", "-");
}
// ─── Server ──────────────────────────────────────────────────────────────────
const server = new McpServer({
    name: "pkbwl-mcp",
    version: "1.0.0",
});
// ── Tool: list_reports ───────────────────────────────────────────────────────
server.tool("list_reports", "Search and filter aviation accident/incident reports from the Polish PKBWL database. " +
    "Returns report metadata. Use get_report for full details and PDF links.", {
    aircraft_type: z
        .string()
        .optional()
        .describe("Filter by aircraft type or manufacturer (case-insensitive substring match). E.g. 'Cessna 152', 'Robinson R44', 'Piper'"),
    category: z
        .string()
        .optional()
        .describe("Filter by aircraft category (case-insensitive substring). E.g. 'airplane', 'helicopter', 'glider', 'balloon', 'parachute', 'UAV'"),
    classification: z
        .enum(["ACCIDENT", "SERIOUS_INCIDENT", "INCIDENT", "OCCURRENCE"])
        .optional()
        .describe("Filter by occurrence classification"),
    date_from: z
        .string()
        .optional()
        .describe("Filter occurrences from this date (YYYY-MM-DD, inclusive)"),
    date_to: z
        .string()
        .optional()
        .describe("Filter occurrences until this date (YYYY-MM-DD, inclusive)"),
    location: z
        .string()
        .optional()
        .describe("Filter by location (case-insensitive substring match on place name or ICAO code)"),
    has_preliminary_report: z
        .boolean()
        .optional()
        .describe("If true, only return reports that have a preliminary report PDF"),
    has_final_report: z
        .boolean()
        .optional()
        .describe("If true, only return reports that have a final report PDF"),
    has_safety_recommendations: z
        .boolean()
        .optional()
        .describe("If true, only return reports with safety recommendations"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum number of results to return (default: 50, max: 500)"),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Offset for pagination (default: 0)"),
}, async (args) => {
    const all = await fetchAllReports();
    const classificationMap = {
        ACCIDENT: "WYPADEK",
        SERIOUS_INCIDENT: "POWAŻNY INCYDENT",
        INCIDENT: "INCYDENT",
        OCCURRENCE: "ZDARZENIE",
    };
    let filtered = all.filter((r) => {
        if (args.aircraft_type) {
            const needle = args.aircraft_type.toLowerCase();
            const haystack = (r.typ_statku_powietrznego ?? "").toLowerCase();
            if (!haystack.includes(needle))
                return false;
        }
        if (args.category) {
            const needle = args.category.toLowerCase();
            const haystack = (r.kategoria_statku_powietrznego ?? "").toLowerCase();
            if (!haystack.includes(needle))
                return false;
        }
        if (args.classification) {
            const keyword = classificationMap[args.classification];
            if (!keyword || !r.klasyfikacja_zdarzenia.includes(keyword))
                return false;
        }
        if (args.date_from && r.data_zdarzenia < args.date_from)
            return false;
        if (args.date_to && r.data_zdarzenia > args.date_to)
            return false;
        if (args.location) {
            const needle = args.location.toLowerCase();
            const haystack = (r.miejsce_zdarzenia ?? "").toLowerCase();
            if (!haystack.includes(needle))
                return false;
        }
        if (args.has_preliminary_report !== undefined) {
            if (normalizeFlag(r.raport_wstepny) !== args.has_preliminary_report)
                return false;
        }
        if (args.has_final_report !== undefined) {
            if (normalizeFlag(r.raport_koncowy) !== args.has_final_report)
                return false;
        }
        if (args.has_safety_recommendations !== undefined) {
            if (normalizeFlag(r.zalecenia_bezpieczenstwa) !== args.has_safety_recommendations)
                return false;
        }
        return true;
    });
    const total = filtered.length;
    const page = filtered.slice(args.offset, args.offset + args.limit).map((r) => ({
        id: r.nr_pkbwl,
        permalink: r.permalink,
        date: r.data_zdarzenia,
        investigation_closed: r.data_zakonczenia_badania,
        aircraft_type: r.typ_statku_powietrznego,
        aircraft_category: r.kategoria_statku_powietrznego,
        registration: r.znaki_rozpoznawcze,
        classification: r.klasyfikacja_zdarzenia,
        location: r.miejsce_zdarzenia,
        has_preliminary_report: normalizeFlag(r.raport_wstepny),
        has_final_report: normalizeFlag(r.raport_koncowy),
        has_resolution: normalizeFlag(r.uchwala),
        has_safety_recommendations: normalizeFlag(r.zalecenia_bezpieczenstwa),
    }));
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ total_matching: total, offset: args.offset, results: page }, null, 2),
            },
        ],
    };
});
// ── Tool: get_report ─────────────────────────────────────────────────────────
server.tool("get_report", "Fetch full details of a specific PKBWL report: metadata, Polish and English summary, " +
    "and URLs of all available PDF documents (preliminary report, final report, resolution, etc.).", {
    report_id: z
        .string()
        .describe("Report ID as shown in the database (e.g. '2020-3377' or '2020/3377'). " +
        "Use list_reports to find IDs."),
}, async (args) => {
    const slug = reportIdToSlug(args.report_id);
    const url = `${BASE_URL}/raporty/${slug}/`;
    const res = await fetch(url, {
        headers: { ...HEADERS, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    if (!res.ok)
        throw new Error(`Failed to fetch report page: ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    // Remove navigation/footer noise
    $("script, style, nav, header, footer, .nav, .footer, .header, #wpadminbar").remove();
    // Extract metadata table rows
    const metadata = {};
    $("table tr, .report-meta tr, dl dt, dl dd").each((_, el) => {
        const cells = $(el).find("td, th");
        if (cells.length >= 2) {
            const key = $(cells[0]).text().trim();
            const val = $(cells[1]).text().trim();
            if (key && val)
                metadata[key] = val;
        }
    });
    // Extract summary sections (Polish + English)
    let summary = "";
    // Look for content after "STRESZCZENIE" / "SUMMARY" headings
    $("h1, h2, h3, h4, p, .summary, .streszczenie").each((_, el) => {
        const text = $(el).text().trim();
        if (text)
            summary += text + "\n\n";
    });
    // Extract PDF links
    const pdfs = [];
    $("a[href]").each((_, el) => {
        const href = $(el).attr("href") ?? "";
        if (href.endsWith(".pdf")) {
            const label = $(el).text().trim() || $(el).attr("href")?.split("/").pop() || href;
            const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
            pdfs.push({ label, url: fullUrl });
        }
    });
    // Also get metadata from the API for completeness
    const all = await fetchAllReports();
    const apiRecord = all.find((r) => r.nr_pkbwl.replace("/", "-") === slug || r.nr_pkbwl === args.report_id);
    const result = {
        id: apiRecord?.nr_pkbwl ?? args.report_id,
        url,
        date: apiRecord?.data_zdarzenia,
        aircraft_type: apiRecord?.typ_statku_powietrznego,
        aircraft_category: apiRecord?.kategoria_statku_powietrznego,
        registration: apiRecord?.znaki_rozpoznawcze,
        classification: apiRecord?.klasyfikacja_zdarzenia,
        location: apiRecord?.miejsce_zdarzenia,
        investigation_closed: apiRecord?.data_zakonczenia_badania,
        metadata,
        summary: summary.replace(/\n{3,}/g, "\n\n").trim(),
        pdf_documents: pdfs,
    };
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
// ── Tool: read_pdf ───────────────────────────────────────────────────────────
server.tool("read_pdf", "Download a PDF document from a PKBWL report and extract its full text content. " +
    "Use the PDF URLs returned by get_report. This is how you access the detailed " +
    "investigation findings, causes, and safety recommendations.", {
    pdf_url: z
        .string()
        .url()
        .describe("Full URL of the PDF to read (from the pdf_documents list returned by get_report). " +
        "E.g. 'https://pkbwl.gov.pl/wp-content/uploads/2023/01/2020_3377_RK.pdf'"),
    max_chars: z
        .number()
        .int()
        .min(1000)
        .max(100000)
        .default(50000)
        .describe("Maximum number of characters to return from the PDF text (default: 50000). " +
        "Large final reports may be truncated; reduce for a quick overview."),
}, async (args) => {
    const res = await fetch(args.pdf_url, {
        headers: {
            ...HEADERS,
            Accept: "application/pdf,*/*",
            Referer: `${BASE_URL}/rejestr-zdarzen/`,
        },
    });
    if (!res.ok)
        throw new Error(`Failed to fetch PDF: ${res.status} ${args.pdf_url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const fullText = result.text;
    const text = fullText.slice(0, args.max_chars);
    const truncated = fullText.length > args.max_chars;
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    url: args.pdf_url,
                    pages: result.total,
                    chars_total: fullText.length,
                    truncated,
                    text,
                }, null, 2),
            },
        ],
    };
});
// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map