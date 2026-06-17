# Agentic HRMS Schema Update Workflow

## What This Project Does

This project is a **fully autonomous agentic workflow** that takes a plain English (natural language) instruction — for example, *"Add a field for tracking employee parking permit allocation"* — and automatically updates an existing enterprise HRMS (Human Resource Management System) data schema to include it, **end to end, with no manual steps**.

In simple terms: instead of a developer manually opening a schema file, writing new JSON fields by hand, testing them, and then committing/pushing to GitHub, this system does all of it by itself:
1. Takes the requirement in plain English
2. Generates the correct schema update using an AI reasoning engine
3. Checks that the update is structurally valid
4. If it's not valid (or if the AI service itself fails temporarily), automatically retries and self-corrects — without a human stepping in
5. Saves the result to disk
6. **Automatically stages, commits, and pushes the change to this GitHub repository** — the entire pipeline runs from a single command with zero manual Git steps

---

## Tools & Technology Used

| Component | Tool / Technology |
|---|---|
| Schema format | JSON Schema (Draft-07) |
| Programming language | Python |
| AI reasoning engine | Google Gemini API (`gemini-2.5-flash`) |
| Version control automation | Python `subprocess` module calling Git directly |
| Version control hosting | GitHub |
| Secrets management | `.env` file (excluded from Git via `.gitignore`) |
| Development environment | VS Code |

---

## The Prompt Used to Drive Schema Updates

The AI reasoning step is governed by a fixed system prompt. This prompt is what forces the output to be predictable, structured, and directly usable by the program — rather than free-form conversational text:

```
You are an autonomous AI Engineer. Your job is to update the existing software schema.
You must output your response STRICTLY in this JSON format. No conversational text, no markdown blocks.

{
  "thought_process": "Explain your logic for adding or modifying these fields",
  "updated_schema": { ... entire updated JSON structure ... },
  "status": "success"
}
```

**Why this prompt is designed this way:**
- It forces strictly parseable JSON output — no markdown fences, no extra commentary to strip out before the program can use the result.
- The `thought_process` field requires explicit reasoning about *why* a field is being added and *where* it belongs in the schema, before the schema itself is generated. This improves placement accuracy (e.g., a bonus field goes under payroll, not under personal details).
- The `status` field lets the program detect success vs. failure programmatically, which is what drives the retry logic and, ultimately, whether the Git pipeline fires at all.

---

## Project Structure

```
agentic-hrms-repo/
├── employee_model.json   # The HRMS JSON Schema being extended (the "existing software")
├── agent_workflow.py      # The agentic workflow: input -> AI call -> validation -> retry -> auto Git push
├── .env                    # API key (never committed -- excluded via .gitignore)
├── .gitignore               # Ensures secrets are never pushed to GitHub
└── README.md                 # This file
```

---

## How the Workflow Runs (Step by Step)

1. **Input** — The script prompts in the terminal: *"Enter your natural language schema update requirement:"*. A plain English sentence is typed here.
2. **Schema Load** — The existing `employee_model.json` is read from disk.
3. **AI Call** — The current schema plus the requirement are sent to the Gemini API using the system prompt above.
4. **Validation** — The returned schema is checked for valid JSON structure and a minimum level of structural complexity (it must contain genuinely nested objects/arrays, not a trivial addition).
5. **Retry Loop** — If validation fails, or if the API itself fails (for example, a temporary `503 Service Unavailable` from Google's servers), the error is logged and the workflow automatically retries, up to 3 attempts, before flagging the run for manual review.
6. **Save** — On success, `employee_model.json` is overwritten with the updated schema on disk.
7. **Automated Git Pipeline** — Immediately after a successful validation, the workflow calls `auto_git_commit_and_push()`, which:
   - Runs `git add employee_model.json`
   - Runs `git commit` with a dynamically generated message that includes the natural language requirement used for that run (e.g. `feat: auto-update schema - Add a field for tracking employee parking permits`)
   - Runs `git push origin master`
   - Logs the output of every Git command through the same logger used for the rest of the workflow
   - If there is nothing new to commit, this is logged as an informational message rather than treated as an error
   - If the push fails (for example, a network or authentication issue), the failure is logged as an error, but the script does **not** crash — the schema update on disk is still considered a successful run, since the Git push is a delivery step layered on top of the core schema-update task

This means a single command — `python agent_workflow.py` — takes a plain English sentence all the way through to a live, version-controlled change on GitHub, with no manual Git commands required at any point.

---

## Schema Domains — What Each Section Represents

The schema models a full enterprise employee record across these areas:

| Domain | What It Tracks |
|---|---|
| `personal_details` | Name, date of birth, gender |
| `tax_compliance` | Tax jurisdiction, encrypted tax ID, withholding declarations, filing history, tax brackets |
| `tiered_payroll_structure` | Salary bands, base pay, bonuses, allowances, retirement matching, deduction priority, anniversary bonuses |
| `esop_vesting_schedule` | Company stock/equity grants, vesting timelines, exercise history, acceleration clauses |
| `performance_matrix` | Goal tracking (OKRs), manager ratings, performance improvement plans |
| `background_verification` | Criminal record, education, employment, credit, and reference checks |
| `benefits_enrollment` | Health, dental, vision, life insurance; dependents |
| `time_and_attendance` | Leave balances, work schedule, attendance exceptions |
| `work_authorization_visa` | Passport, visa, and immigration sponsorship details |
| `career_and_learning_development` | Training, certifications, course completion, learning budget |
| `disciplinary_and_grievance_records` | Disciplinary actions and employee grievances |
| `employee_status` | Current employment state (Active, On_Leave, Terminated, Retired) |
| `employee_id` / `tenant_id` | Unique identifiers (the latter supports multiple companies using the same system) |

---

## Field-Level Explanation and Constraints

### `personal_details`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `first_name`, `last_name` | Employee's name | Plain string, no pattern | Names vary too much across cultures to safely restrict with a pattern |
| `middle_name` | Optional middle name | Not required | Many cultures and naming conventions don't use a middle name |
| `date_of_birth` | Birth date | `format: date` (must be YYYY-MM-DD) | Ensures consistent, parseable dates across the system |
| `gender` | Gender identity | `enum`: Male, Female, Non-binary, Prefer not to say | Prevents inconsistent free-text values (e.g. "M", "male", "MALE") and supports inclusive, legally compliant categories |

### `tax_compliance`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `country_code` | Tax jurisdiction country | `pattern: ^[A-Z]{2}$` | Enforces the ISO 3166-1 two-letter country code standard, avoiding free-text inconsistency |
| `tax_identifier_encrypted` | The employee's tax ID (e.g. SSN, PAN) | Stored as an encrypted object (`ciphertext`, `iv`, `key_version`, `algorithm`), never plain text | Tax IDs are sensitive PII; application-level encryption protects the data even if the database itself is compromised |
| `filing_status` | Marital/tax filing category | `enum` of 5 fixed values, including `Expat_Non_Resident` | Mirrors real tax law categories; the expat category supports a global, multi-country workforce |
| `allowances_claimed` | Number of withholding allowances | `minimum: 0` | Allowances can never be negative |
| `tax_year` (in filing history) | Year of a tax filing record | `minimum: 2000, maximum: 2100` | Sanity bound to catch typo years like 1850 or 9999 |
| `form_type` | Type of tax form filed | `enum` covering US, Canada, UK, India, Hong Kong forms | Reflects genuine multi-country tax compliance |
| `dual_residency_status` | Whether the employee is a tax resident in two countries | Boolean | Flags double-taxation risk for HR/legal follow-up |
| `tax_bracket_details` | Progressive tax bracket structure by jurisdiction and year | Nested array: outer array per jurisdiction, inner array of `{income_threshold_min, marginal_rate_percent, base_tax_amount}` | Real tax systems are progressive (different rates apply above different income thresholds); this models that directly rather than storing only a single total withheld amount |

### `tiered_payroll_structure`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `grade_level` | Job level/band | `pattern: ^L[1-9][0-9]?$` (e.g. L1-L99) | Matches common corporate leveling conventions (L1, L5, L12) |
| `currency` | Pay currency | `pattern: ^[A-Z]{3}$` | Enforces ISO 4217 three-letter currency codes (USD, INR, EUR) |
| `allocation_percentage` (direct deposit) | Percent of pay sent to a given bank account | `minimum: 0, maximum: 100` | Cannot allocate less than 0% or more than 100% of pay |
| `deductions_hierarchy` / `priority_index` | Order in which deductions are taken if pay is insufficient | `minimum: 1` (1 = highest priority) | Models real payroll rules — statutory deductions like tax levies must be prioritized over optional ones like loan repayments |
| `anniversary_bonuses` | One-time bonuses tied to work-anniversary milestones | Array of `{milestone_year (>=1), bonus_amount: {amount >= 0, currency}, payout_date, status: enum}` | Models milestone-based recognition pay (5/10/15-year bonuses) as a recurring, trackable structure, with a status field to track whether each milestone payout is pending, paid, or waived |

### `esop_vesting_schedule`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `security_type` | Type of equity grant | `enum`: ISO, NSO, RSU, Stock_Options | Matches standard equity compensation categories |
| `vesting_mechanism.type` | How vesting is earned | `enum`: Time_Based, Performance_Based, Milestone_Hybrid | Real equity grants vest either on a timeline, on performance targets, or a mix of both |
| `cliff_duration_months` | Minimum months before any shares vest | `minimum: 0` | A negative cliff period is meaningless |
| `current_fmv_per_share` | Latest Fair Market Value per share | Object with `amount`, `currency`, `as_of_date` | Share value changes over time and must be tied to a specific valuation date for accuracy |
| `acceleration_clauses` | Conditions that speed up vesting | `enum`: Single_Trigger_COC, Double_Trigger_COC, IPO, Termination_Without_Cause, Death_Disability | Models real legal clauses in equity agreements that change vesting if the company is acquired, goes public, or the employee is terminated |

### `employee_status`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `employee_status` | Current employment state | `enum`: Active, On_Leave, Terminated, Retired | A core operational field — nearly every downstream process (payroll, benefits, access control) depends on knowing whether an employee is currently active |

### `performance_matrix`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `weightage` (per OKR) | How much an objective counts toward the overall score | `minimum: 0, maximum: 1.0` | Weightings are expressed as a fraction of 100% |
| `self_assessment_score` / `manager_assessment_score` | Rating given to a key result | `minimum: 1.0, maximum: 5.0` | Matches a standard 5-point performance rating scale |
| `nine_box_placement` | Calibrated performance/potential category | `enum` of 9 standard talent-grid labels | Reflects the widely used "9-box grid" talent management framework |

### `background_verification`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `overall_status` | Result of the background check | `enum`: Initiated, In_Progress, Pass, Pass_With_Discrepancies, Fail, Escalated | Covers the realistic range of outcomes, not just pass/fail |
| `report_reference_hash` | Cryptographic hash of a verification report | String (SHA-256 style hash) | Lets the system verify a report hasn't been tampered with after the fact |

### `work_authorization_visa`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `primary_nationality_iso2` | Employee's nationality | `pattern: ^[A-Z]{2}$` | ISO country code standard, same reasoning as tax jurisdiction |
| `visa_type` | Type of work visa | `enum` of real visa categories (H1-B, L-1A, O-1, etc.) plus `Not_Applicable` | Supports employees who don't need a visa without leaving the field empty/ambiguous |

### `time_and_attendance`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `leave_type` | Category of leave | `enum`: Annual_Leave, Sick_Leave, Bereavement_Leave, Parental_Leave, Jury_Duty, Sabbatical | Standard leave categories used in enterprise HR policy |
| `valid_radius_meters` | Allowed distance from a registered work site for clock-in (geofencing) | Integer | Used to validate that remote/on-site clock-ins happen from an approved location |

### `disciplinary_and_grievance_records`

| Field | Meaning | Constraint | Why |
|---|---|---|---|
| `severity_tier` | How serious a disciplinary incident is | `enum`: Low, Medium, High, Critical | Drives what level of review/approval is required |
| `allegations_details_encrypted` | Description of a policy violation | Stored as an encrypted string | Disciplinary details are highly sensitive and must not be stored in plain text |

---

## How to Run This Project

### 1. Install Python dependencies
```bash
pip install python-dotenv requests
```

### 2. Add your API key
Create a `.env` file in the project root (this file is git-ignored and never pushed):
```
GEMINI_API_KEY=your_key_here
```

### 3. Run the workflow
```bash
python agent_workflow.py
```

### 4. Enter your requirement
When prompted in the terminal, type a plain English sentence describing the schema change, for example:
```
Add a field for tracking employee parking permit allocation with permit number and assigned parking zone.
```

### 5. That's it
No further action is needed. The workflow validates the result and automatically commits and pushes the change to GitHub. The terminal output will show each Git step (`Git add output`, `Git commit output`, `Git push output`) as confirmation.

To manually double-check what changed at any time:
```bash
git log -n 5
```

---

## Design Decisions

- **Structured JSON-only AI output** — avoids fragile parsing of free-form text and keeps the workflow fully automatable.
- **`thought_process` as a required output field** — forces reasoning about where a field belongs before it's generated, improving placement quality.
- **Validation checks structure, not business logic** — the validator confirms the schema is syntactically correct and substantively complex, rather than simulating real payroll/tax math, keeping the workflow focused within scope.
- **Retry capped at 3 attempts** — allows genuine self-correction (both for invalid AI output and for transient API failures like a `503` error) without risking an infinite loop; anything beyond 3 attempts is flagged for manual review.
- **Git commit and push are fully automated, triggered only after validation succeeds** — this guarantees that only schema versions which have already passed structural validation are ever pushed to the remote repository; a failed or invalid generation never reaches GitHub.
- **Git push failures do not crash the workflow** — a push can fail for reasons unrelated to the schema itself (network connectivity, authentication). Since the schema update on disk is the core deliverable, a push failure is logged as an error for visibility but does not roll back or invalidate the successful schema update.
- **Secrets are excluded from version control from the start** — `.env` was added to `.gitignore` before the first commit to prevent any API key from ever entering the repository's history.
