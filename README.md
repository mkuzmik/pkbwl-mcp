# pkbwl-mcp

An MCP server for searching and analysing aviation accident and incident reports from the [PKBWL](https://pkbwl.gov.pl) (Państwowa Komisja Badania Wypadków Lotniczych — Polish State Commission on Aircraft Accident Investigation) database.

## Tools

### `list_reports`
Search and filter the full registry of 2300+ reports by:
- `aircraft_type` — manufacturer/type substring (e.g. `"Cessna 152"`, `"Robinson R44"`)
- `category` — aircraft category substring (e.g. `"airplane"`, `"helicopter"`, `"glider"`, `"balloon"`, `"UAV"`)
- `classification` — `ACCIDENT` | `SERIOUS_INCIDENT` | `INCIDENT` | `OCCURRENCE`
- `date_from` / `date_to` — YYYY-MM-DD range
- `location` — place name or ICAO code substring
- `has_preliminary_report` / `has_final_report` / `has_safety_recommendations` — boolean flags
- `limit` (default 50, max 500) / `offset` — pagination

### `get_report`
Fetch full details of a specific report by ID (e.g. `"2020-3377"`):
- All metadata fields
- Polish + English summary text
- List of available PDF documents with URLs

### `read_pdf`
Download a PDF from the report (using the URL returned by `get_report`) and extract its full text. This gives you access to:
- Detailed investigation narrative
- Causal factors and contributing factors
- Safety recommendations

## Usage example

> "Get all Cessna 152 accidents and group them by the most common causes"

```
list_reports(aircraft_type="Cessna 152", classification="ACCIDENT", has_final_report=true)
→ for each: get_report(id) → read_pdf(final_report_url)
→ summarise causes across all reports
```

## Setup

```bash
npm install
npm run build
```

### Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "pkbwl": {
      "command": "node",
      "args": ["/Users/mat/Code/pkbwl-mcp/dist/index.js"]
    }
  }
}
```

## Development

```bash
npm run dev   # run with tsx (no build step)
npm run build # compile to dist/
npm start     # run compiled build
```

## Notes

- The reports list is cached in-memory for 5 minutes to avoid hammering the API.
- All text on the PKBWL website is in Polish; summaries typically include a Polish narrative. PDF final reports are in Polish.
- Report IDs accept both slash (`2020/3377`) and hyphen (`2020-3377`) formats.
