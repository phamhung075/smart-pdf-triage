# 📁 Smart PDF Triage Dashboard

> **AI-Powered PDF Classification, Entity Extraction & Folder Sorting System**

An intelligent, privacy-first PDF classification, entity extraction, and automated document sorting system powered by local AI (**Qwen 3.5 via Ollama**).

---

## 🌟 Key Features

- 🧠 **100% Local AI Classification**: Runs locally using Ollama (`qwen3.5:9b`). Zero document data sent to external cloud APIs.
- 🏢 **Multi-Tenant & Generic Architecture**: Built for Individuals, Families, Freelancers, SMBs, and Enterprise Corporations. Zero hardcoded personal names.
- 🧾 **Dual Invoice Triage**: Automatically distinguishes between **Client Sales Invoices** (`factures_clients`) and **Supplier Purchase Invoices** (`invoices`).
- 💳 **Payment Status Tracking**: Automatically extracts payment signals and tags invoices as `PAID` or `UNPAID / PENDING`.
- 🪪 **Identity & Legal Document Sorting**: Intelligent routing for Residence Permits (`titre_sejour`), Passports, CNI, Tax Notices, and Pay Slips (`bulletin_salaire`).
- 📍 **Interactive Relocalize Modal**: Human-in-the-loop UI to manually correct document locations or provide structured feedback to train local AI.
- 🛡️ **Strict Fail Guard**: Blocks ungrounded or generic folder creation, keeping unclassified files safely in `__raws` for review.
- ⚡ **Real-Time Web Dashboard**: Live SSE events, SQLite FTS5 instant search, dark-mode UI, and registry repair utilities.

---

## 🛠️ Technology Stack

- **Core Engine**: TypeScript, Node.js, Express
- **AI / LLM**: Ollama (`qwen3.5:9b`), Local Embeddings (`nomic-embed-text`)
- **Database**: SQLite3 with FTS5 Full-Text Search
- **PDF Extraction**: `pdf-parse` / PDF.js
- **Testing & Build**: Vitest, ESBuild, TypeScript Compiler (`tsc`)

---

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js** v20+ installed.
- **Ollama** installed locally ([ollama.com](https://ollama.com)).
- Pull the required model:
  ```bash
  ollama pull qwen3.5:9b
  ```

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/<your-username>/smart-pdf-triage.git
cd smart-pdf-triage

# Install dependencies
npm install
```

### 3. Setup Configuration

Create your `settings.json` from the example template:

```bash
cp settings.json.example settings.json
```

Configure your input folder (`input_dir`) and target archive folder (`output_root_dir`) in `settings.json`:

```json
{
  "input_dir": "./input",
  "output_root_dir": "./organized",
  "ollama_model": "qwen3.5:9b",
  "ollama_host": "http://127.0.0.1:11434",
  "personal_name_denylist": []
}
```

### 4. Run Development Server

```bash
npm run dev
```

Open **`http://localhost:3000`** in your browser!

---

## 📂 Supported Taxonomy Categories

| Category ID | Description | Primary Subcategories |
| :--- | :--- | :--- |
| **`factures_clients`** | Sales Invoices Issued to Clients | Client Company Names |
| **`invoices`** | Purchase Invoices Received from Suppliers | Supplier Vendor Names (`sfr`, `edf`, `aws`) |
| **`bulletin_salaire`** | Pay Slips & Employer Payroll | Employer / Company Names |
| **`identity`** | Passports, ID Cards, Titres de Séjour | `titre_sejour`, `passeport`, `carte_identite` |
| **`administrative`** | Tax Notices, Government, Bank Statements | `impot`, `credit_mutuel`, `societe_generale` |
| **`health`** | Medical, Social Security, Mutual Insurance | `ameli`, `cpam`, `mutuelle` |
| **`housing`** | Leases, Rent Receipts, Domicile Proofs | `justificatif_domicile`, `foncia` |
| **`contracts`** | Employment & Commercial Contracts | `cdi_cdd`, `conditions_generales` |
| **`education`** | Academic Diplomas, Certificates, Training | `diplomes`, `cesi`, `openclassrooms` |
| **`recruitment`** | Resumes & Cover Letters | `cv`, `lettre_motivation` |

---

## 🧪 Testing & Code Quality

Run unit tests and TypeScript type checking:

```bash
# Run all 88 unit tests
npm test

# Run TypeScript type check
npx tsc --noEmit
```

---

## 📄 License

MIT License. Free for personal, commercial, and enterprise use.
