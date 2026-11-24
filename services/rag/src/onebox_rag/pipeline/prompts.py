"""Prompts for the vision model."""

OCR_PROMPT = """# Role
You are a precise document OCR specialist. Convert the provided document image to clean, accurate markdown.

# Core Instructions
1. **Extract all visible text** exactly as written: preserve spelling, punctuation, capitalization, and numbers verbatim
2. **Maintain reading order**: top-to-bottom, left-to-right (or appropriate order for multi-column layouts)
3. **Preserve document hierarchy** using markdown: `#` for titles, `##` for sections, `###` for subsections

# Formatting Rules

## Text Styling
- **Bold** for text that appears bold/emphasized
- *Italic* for italicized text
- `code` for monospaced/typed text

## Lists
- Use `-` for unordered lists
- Use `1.` for numbered lists
- Preserve nested indentation

## Tables
- Convert all tables to markdown table format
- Use `|` separators and `---` header dividers
- Align columns appropriately

## Images & Visual Elements
- Include ALL images, photos, diagrams, charts, logos, and illustrations
- Use format: `{{IMAGE: description}}`
- Place image placeholders in their correct reading order position within the document
- Descriptions should be informative and detailed:
  - For charts/graphs: include type, axis labels, legend info, and key data points
  - For diagrams: describe structure, flow direction, and labeled components
  - For logos: include company/brand name if identifiable
  - For photos: describe subject, setting, and relevant details
  - For decorative images: brief description is sufficient
- If the entire page is a single image with no text: `{{IMAGE: comprehensive description}}`

### Image Examples
- Logo: `{{IMAGE: Acme Corp logo - red triangle with company name below}}`
- Chart: `{{IMAGE: Bar chart showing Q1-Q4 revenue on x-axis, dollars in millions on y-axis, values ranging from $10M to $45M}}`
- Photo: `{{IMAGE: Team of five people gathered around conference table in modern office}}`
- Diagram: `{{IMAGE: Flowchart with 5 boxes connected by arrows showing approval process: Submit → Review → Approve → Implement → Complete}}`

## Special Elements
- Checkboxes: `[ ]` (unchecked) or `[x]` (checked)
- Preserve line breaks where semantically meaningful
- Represent horizontal rules as `---`

# Output
Return ONLY the extracted markdown. No preamble, no explanations, no commentary."""

DESCRIBE_PROMPT = """# Role
You are a precise document image-to-text specialist. Convert the provided image into clean, searchable text for enterprise document indexing.

# Core Instructions
1. **Extract all visible text** exactly as written: preserve spelling, punctuation, capitalization, numbers, and units verbatim
2. **Maintain reading order**: top-to-bottom, left-to-right (or the natural order for multi-column or diagram layouts)
3. **Preserve structure** using markdown where helpful: headings (`#`), lists (`-` / `1.`), **bold**, *italic*, and tables (`|` with `---` headers)

# Visual Elements
When the image contains non-text content, describe it in enough detail to be searchable:
- **Charts/graphs**: type, title, axis labels, legend, and key values or trends
- **Diagrams/flowcharts**: structure, flow direction, and labeled components or connections
- **Tables rendered as images**: transcribe cell contents row by row
- **Logos/branding**: company or product name if identifiable
- **Photos/illustrations**: subject, setting, and any visible labels or signage
- **UI screenshots**: app or page name, visible controls, and on-screen text

If the image is purely visual with no readable text, provide a thorough descriptive transcription instead of a one-line caption.

# Output
Return ONLY the extracted and converted text. No preamble, no explanations, no commentary."""

TABLE_ANALYSIS_SYSTEM = "You are a data analysis expert. Analyze table rows to detect if headers exist and how many rows they span, generate column names when needed, and summarize the table."

TABLE_ANALYSIS_PROMPT = """Analyze these first rows of a table:
{rows_text}

Number of columns: {column_count}
{header_context}
Determine:
1. Does this table have headers? (true/false)
2. If yes, how many rows do the headers span? (1, 2, 3, or more)

CRITICAL RULE for header detection:
- A row is a header row ONLY if ALL non-empty cells contain header-like values (category descriptors)
- If even ONE cell contains a data value (specific measurement, number, amount, identifier), the ENTIRE row is NOT a header
- You MUST check EVERY non-empty cell - do not stop after checking the first cell
- Empty cells can be ignored

COMMON MISTAKE to avoid:
- Row where first cell looks like a label but remaining cells are numeric values
- Example: ["Gross AOV", "$55.89", "$53.33", ...]
- This is NOT a header row - it's a DATA row with a row label in the first column
- The values $55.89, $53.33 are specific measurements, not category descriptors

CORE PRINCIPLE - Understanding Headers vs Data:

HEADER-LIKE values describe CATEGORIES or TYPES:
- They answer: "What TYPE/CATEGORY of information is in this column?"
- They are DESCRIPTIVE LABELS that remain constant across rows
- Examples: "Name", "Age", "Department", "Q1_Sales", "Region", "Month"

DATA values are SPECIFIC INSTANCES or MEASUREMENTS:
- They answer: "What is the SPECIFIC VALUE for this entry?"
- They are ACTUAL MEASUREMENTS, OBSERVATIONS, or IDENTIFIERS that vary from row to row
- Examples: "John Smith", 35, $55.89, 0.95, "jan-2024", "North", "ABC-123"

KEY INSIGHT - Numbers and Measurements:
- ANY specific numeric value, regardless of format, is DATA: plain numbers (42, 1250.50), currency ($55.89, €100), percentages (95.5%), dates (2024-01-15, Jan-2024)
- Numeric labels that describe columns could be headers: "Q1", "Q2", "2024", "Month1" (but only alongside OTHER header-like values, not mixed with data)

Examples:

Example 1 - Valid single-row header:
Row 1: ["Name", "Age", "Department", "Salary"]
Row 2: ["John Smith", 35, "Sales", 75000]
→ has_headers: true, num_header_rows: 1

Example 2 - Invalid header (contains data):
Row 1: ["Name", "John Smith", "Age", 35]
Row 2: ["Department", "Sales", "Salary", 75000]
→ has_headers: false, num_header_rows: 0

Example 3 - Valid multi-row header:
Row 1: ["Sales", "Sales", "Expenses", "Expenses"]
Row 2: ["Q1", "Q2", "Q1", "Q2"]
Row 3: [1250, 1430, 890, 920]
→ has_headers: true, num_header_rows: 2

Example 4 - Row labels with data values, no header:
Row 1: ["Gross AOV", "$55.89", "$53.33", "$58.22"]
Row 2: ["Net AOV", "$73.28", "$74.65", "$74.00"]
→ has_headers: false, num_header_rows: 0

Also produce:
3. "headers": EXACTLY {column_count} column names.
   - If num_header_rows is 1: use Row 1's values (fill blanks with Column_N).
   - If num_header_rows is more than 1: you may leave headers as an empty list.
   - If has_headers is false: invent clear, concise, unique names from the data, EXACTLY {column_count} of them.

4. "summary": 2-4 sentences describing this table's purpose and content (always required).

Respond with a JSON object:
{{
    "has_headers": true or false,
    "num_header_rows": 0 or 1 or 2 or 3,
    "headers": ["Header1", "Header2", ...] or [],
    "summary": "Summary of the table"
}}"""

KNOWN_HEADERS_CONTEXT = """
The column headers are already known: {headers}
Use them verbatim as "headers", and set "has_headers" to false and "num_header_rows" to 0: none of the rows above is a header row.
"""

NO_HEADERS_CONTEXT = """
None of the rows above is a header row: set "has_headers" to false and "num_header_rows" to 0, and invent column names from the data.
"""

ROW_TEXT_SYSTEM = """You are a data analysis expert who converts structured data into natural language descriptions.
Your task is to convert each row of data into a clear, concise and detailed natural language description.
Use the provided table summary to make the descriptions more meaningful.

RULES:
- Every row is listed with a short key in square brackets. Describe each row under its own key: copy the key exactly as written.
- Write one description per row. Do NOT combine rows and do NOT split a row.
- Do NOT put keys, row numbers or phrases like "Row 1:" inside the description text.
- Keep every value (names, numbers, dates, amounts) exactly as given."""

ROW_TEXT_PROMPT = """Convert the following rows of data into natural language descriptions.

Table Summary:
{table_summary}

Rows Data ({row_count} rows, each with its key):
{keyed_rows}

Respond with ONLY a JSON object with one entry per row, with each key copied from its row:
{{
    "descriptions": [
        {{"key": "<key of the first row>", "description": "Description of that row"}},
        {{"key": "<key of the next row>", "description": "Description of that row"}}
    ]
}}"""


DOCUMENT_CLASSIFY_PROMPT = """
# Task:
You are processing a document of an individual or an enterprise. Your task is to classify the document categories, subcategories, languages, and topics, to list the organizations it names, and to write a summary that a retrieval system will use to decide whether this document is relevant to a user's query.
Instructions must be strictly followed.

# File Metadata:
The file name and type are given with the document content. Use the file metadata as supporting evidence — a name like "invoice_2024_ACME.pdf" or a type of "spreadsheet" can help disambiguate an otherwise ambiguous category. The document content is still the primary source of truth: never infer content, topics, or summary details from the filename alone.

# Analysis Guidelines:
1. Document Type Categories & Subcategories:
   - `category`: Broad classification such as "Security", "Compliance", or "Technical Documentation".
   - `subcategories`:
     - `level1`: General sub-area under the main category.
     - `level2`: A more specific focus within level 1.
     - `level3`: The most detailed classification (if available).
   - Leave levels blank (`""`) if no further depth exists.
   - Do not provide comma-separated values for subcategories

   Example:
      Category: "Legal"
      Sub-category Level 1: "Contract"
      Sub-category Level 2: "Non Disclosure Agreement"
      Sub-category Level 3: "Confidentiality Agreement"

2. Languages:
   - List the natural (human) languages the document is written in
   - Programming languages, markup and data formats (Python, SQL, HTML, JSON, YAML) are not languages here
   - Use full ISO language names (e.g., "English", "French", "German").

3. **Topics**:
   - A topic is a **reusable subject** a reader would look for across many documents ("payment terms", "access reviews", "data retention", "GDPR", "SLA"): a short noun phrase, lowercase except acronyms.
   - **Never** a person, company or other organization, document title, date, amount, or ticket, invoice or contract number: names belong in the summary. Standards, regulations, technologies and methods are fine.
   - Prefer the general term over a phrase only this document uses, and avoid duplicates or near-duplicates.
   - Provide **2 to 5** topics: as few as cover the document, usually 2 or 3.

4. **Organizations**:
   - List the organizations the document names: companies, customers, vendors, partners, employers, investors, regulators, government bodies, universities, non-profits.
   - Copy each name as written ("Acme Corp", "University of Oxford"). List each organization once, even if it appears under several spellings; prefer its fullest name.
   - Do NOT list people, products or services (a product named after its maker counts as the product, e.g. "Jira" is not "Atlassian"), teams or departments, locations, generic words ("the client", "the vendor"), or the application the document came from (an email is not about "Gmail").
   - Include the author's own organization only if the document names it explicitly.
   - At most 10. Leave the list empty if the document names none.

5. **Summary**:
   - This is the single most important field. A retrieval system shows only the FIRST ~600 CHARACTERS of this summary to a model deciding whether to fetch the full document — everything after that point is a bonus, not a guarantee it will be read.
   - **Sentence 1 is load-bearing.** It must state, in this order: document type, primary subject, principal parties or owning team, and time period or effective date. It must stand alone as a complete relevance judgment, since a reader may see nothing else.
   - **Length is tiered to document depth, not fixed:**
     - Thin or sparse documents (a short note, a single form, a fragment): 3 to 5 sentences is enough. Do not pad.
     - Typical documents: aim for no more than 300 words.
     - Never exceed 400 words, regardless of document length.
   - **Density over prose.** After sentence 1, prioritize concrete, searchable facts over connective narration:
     - Named entities verbatim: people, organizations, teams, products, systems, projects, vendors, locations. Do not paraphrase proper nouns. When the document gives both an acronym and its expansion, keep both.
     - Concrete identifiers and figures: amounts with currency, dates, version numbers, ticket/contract/invoice numbers, percentages, quantities.
     - The specific questions this document can answer, and — when evident — the scope it does NOT cover.
   - Write in English; keep proper nouns in their original language and script.
   - **Forbidden:** opening filler ("This document provides...", "The purpose of this document is..."), meta commentary about the document or your own analysis, recommendations, opinions, and any claim not directly supported by the content shown.
   - If the content is too sparse or fragmentary to say anything substantive, write a short, honest summary of only what is verifiably present rather than inventing detail to hit a length target.

# Output:
Return a single structured object matching the required schema. Do not include any additional commentary outside the schema fields.
"""

DOCUMENT_RECORD_HEADER = """# File Metadata:
File name: {record_name}
File type: {record_type}
"""

# Asked when the structured answer never fit its schema; the instructions above follow it.
FALLBACK_SUMMARY_PROMPT = (
    "Provide a concise summary of the following document/record. "
    "Return only the summary text, nothing else."
)
