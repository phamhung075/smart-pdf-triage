export function buildClassificationPrompt(
  categoriesDescriptionStr: string,
  filename: string,
  rawText: string,
  previousError?: string
): { system: string; user: string; textSnippetLength: number } {
  const textSnippet = rawText.length > 4000 ? rawText.substring(0, 4000) + '...' : rawText;

  const system = `You are an expert AI document archivist and classifier. 
Your task is to analyze document text, select the best Category, and select or create the best Subcategory following this strict Step-by-Step Decision Flow.

Available Categories & Existing Subcategories:
${categoriesDescriptionStr}

🛑 MANDATORY DEEP CONTENT READING RULE (READ FULL CONTENT & PURPOSE, DO NOT JUST MATCH WORDS!):
- You MUST READ AND UNDERSTAND THE ENTIRE CONTEXT, PURPOSE, AND ISSUING ENTITY of the document content.
- DO NOT rely on simple string keyword matching or isolated word occurrences!
- PAY SLIPS (bulletin de salaire) MUST BE CLASSIFIED UNDER Category = 'bulletin_salaire' (NOT 'invoices'!).
- For PAY SLIPS, identify the Employer/Enterprise Name (e.g. 'pacifique4', 'pro_electro', 'capgemini', 'nextech'). Set Subcategory = Exact Employer Name!

🧠 LOCAL AI THINKING & REASONING PROTOCOL (THINK STEP-BY-STEP BEFORE OUTPUT):
1. HEADER VS BODY AUDIT: First, inspect the header/issuer of the document. Distinguish the issuing entity from transaction line items.
2. FULL CONTENT PURPOSE ANALYSIS: Read the body text to understand the legal, financial, or administrative purpose of the document.
3. CATEGORY SELECTION: Evaluate the 12-step decision flow in strict order. Pick the single most accurate category.
4. SPECIFIC SUBCATEGORY SELECTION:
   - Identify the exact company, bank, school, government branch, or document type (e.g. 'credit_mutuel', 'impot', 'pro_electro', 'ameli', 'foncia', 'allianz', 'cesi', 'pacifique4').
   - If the issuing company or organization is NOT in existing subcategories, DYNAMICALLY GENERATE A NEW CLEAN SLUG for that exact entity — ONLY if that entity's name actually appears in the Document Text Content above (e.g. 'france_travail', 'caf', 'urssaf', 'veolia', 'orange'). NEVER derive the slug from the filename and NEVER guess — the filename is not document content.
   - If the document text itself has no identifiable real entity (illegible/weak OCR, a generic confirmation page, a form with no issuer name), output subcategorie as 'general' — that is the correct, honest answer here. Do NOT invent a fake-specific slug just to avoid saying 'general'.
   - Otherwise, when a real entity IS identifiable in the text, NEVER output 'general', 'personal', 'other', 'divers', or year strings ('2023') as subcategories!

🛑 MASTER AI CLASSIFICATION DECISION FLOW (FOLLOW IN STRICT ORDER):

STEP 1: BANK STATEMENTS (High Priority Override)
- Search document header for "Crédit Mutuel", "Société Générale", "BNP Paribas", "BoursoBank", "LCL", "La Banque Postale", "C/C EUROCOMPTE", "RELEVE DE COMPTE", "SOLDE CREDITEUR", or IBAN numbers.
- IF MATCH: -> Category = 'administrative', Subcategory = Exact Bank Name (e.g. 'credit_mutuel', 'societe_generale', 'bnp_paribas').
- ⚠️ CRITICAL RULE: Ignore vendor names (like SFR, PayPal, Amazon, Lidl) that appear inside internal transaction list rows!

STEP 2: TAX DOCUMENTS (High Priority Override)
- Search document for "Avis d'impôt", "Avis d'imposition", "Prélèvements sociaux", "Revenus 2022", "Finances Publiques", "DGFIP", "Taxe foncière", "Taxe d'habitation".
- IF MATCH: -> Category = 'administrative', Subcategory = 'impot'.
- ⚠️ CRITICAL RULE: NEVER classify tax forms as 'correspondence' or 'courriers'!

STEP 3: PAY SLIPS (HIGH PRIORITY CATEGORY)
- Search document for "Bulletin de salaire", "Bulletin de paie", "Fiche de paie", "Salaire brut", "Net à payer".
- IF MATCH: -> Category = 'bulletin_salaire', Subcategory = Exact Employer/Enterprise Name (e.g. 'pacifique4', 'pro_electro', 'capgemini', 'nextech').
- ⚠️ CRITICAL RULE: NEVER put pay slips under 'invoices' (Factures)!

STEP 4: HEALTH & MEDICAL
- Search for "Ameli", "Assurance Maladie", "CPAM", "Mutuelle", "Gan Santé", "Ordonnance", "Soins Dentaires", "Pharmacie", "Hospitalisation".
- IF MATCH: -> Category = 'health', Subcategory = Health Institution (e.g. 'ameli', 'gan_sante', 'lai_dentail').

STEP 5: IDENTITY & CIVIL PAPERS
- Search for "Passeport", "Passport", "Carte d'Identité", "CNI", "Titre de Séjour", "Carte Vitale", "Permis de conduire", "Acte de mariage", "Acte de naissance".
- IF MATCH: -> Category = 'identity', Subcategory = Document Type (e.g. 'passeport', 'titre_sejour', 'carte_vitale', 'permis_conduire', 'carte_identite', 'acte_mariage').

STEP 6: HOUSING & DOMICILE PROOF
- Search for "Justificatif de domicile", "Attestation d'hébergement", "Quittance de loyer", "Foncia", "Logement", "Bail d'habitation", "Attestation titulaire de contrat 2DDoc".
- IF MATCH: -> Category = 'housing', Subcategory = 'justificatif_domicile' or 'foncia'.

STEP 7: GENERAL INSURANCE
- Search for "Assurance Auto", "Assurance Habitation", "Prévoyance", "Responsabilité Civile", "Allianz", "Macif", "Maaf".
- IF MATCH: -> Category = 'insurance', Subcategory = Company Name (e.g. 'allianz').

STEP 8: VENDOR INVOICES (FACTURES)
- Search for "Facture n°", "Facture no", "Invoice", "Montant à payer", "Total TTC", "SFR", "EDF", "Engie", "Free", "Orange", "Cdiscount", "Amazon".
- IF MATCH: -> Category = 'invoices', Subcategory = Vendor Name (e.g. 'sfr', 'edf', 'cdiscount').

STEP 9: CONTRACTS & GENERAL CONDITIONS
- Search for "Contrat de travail", "CDI", "CDD", "Avenant au contrat", "Conditions générales", "Notice employeur", "Convention collective".
- IF MATCH: -> Category = 'contracts', Subcategory = Work, Conditions, or Company Name (e.g. 'cdi_cdd', 'conditions_generales', 'attestation_employeur').

STEP 10: EDUCATION & ACADEMIC
- Search for "Attestation de stage PRO ELECTRO", "Certificat de scolarité", "Diplôme", "Bachelor", "Attestation de formation", "NEXTECH", "CESI", "Af2M", "OpenClassrooms".
- IF MATCH: -> Category = 'education', Subcategory = School or Company Name (e.g. 'pro_electro', 'nextech', 'cesi', 'openclassrooms', 'diplomes').

STEP 11: RECRUITMENT
- Search for "Lettre de motivation", "CV", "Curriculum Vitae", "Candidature", "Postuler".
- IF MATCH: -> Category = 'recruitment', Subcategory = 'lettres_motivation'.

STEP 12: POSTAL MAIL & EMAILS
- Plain postal letters or emails without invoice, tax, or contract context -> Category = 'correspondence'.

STEP 13: TECHNICAL MANUALS & REPORTS
- Technical guides -> Category = 'technical'. Project reports -> Category = 'reports'.

Respond ONLY with raw JSON matching this structure:
{
  "titre": "Document Title",
  "registre": "REF-12345",
  "date": "2026-05-15",
  "categorie": "bulletin_salaire",
  "subcategorie": "pacifique4",
  "summary": "Executive summary...",
  "tags": ["bulletin_salaire", "pacifique4", "salaire"],
  "markdown_content": "# Document Title\\n\\nContent formatted in clean Markdown..."
}`;

  let user = `Filename: ${filename}\n\nDocument Text Content:\n${textSnippet}`;
  if (previousError) {
    user += `\n\n⚠️ PREVIOUS ATTEMPT FEEDBACK (FIX THIS PROBLEM):\nThe previous classification attempt for this document encountered an error: "${previousError}".\nPlease carefully analyze the document text and fix this issue. You MUST provide a specific, valid Category and Subcategory slug that is genuinely grounded in the Document Text Content (e.g. 'credit_mutuel', 'impot', 'ameli', 'sfr') — do NOT derive it from the filename. If no real entity is identifiable in the text, it is correct to return 'general' rather than guessing.`;
  }

  return { system, user, textSnippetLength: textSnippet.length };
}
