/**
 * A KBC Business export, as the bank writes its header. The two rows are
 * invented: the repository is public.
 */
export const KBC_COLUMNS = [
  "Rekeningnummer",
  "Rubrieknaam",
  "Naam",
  "Munt",
  "Afschriftnummer",
  "Datum",
  "Omschrijving",
  "Valuta",
  "Bedrag",
  "Saldo",
  "credit",
  "debet",
  "rekeningnummer tegenpartij",
  "BIC tegenpartij",
  "Naam tegenpartij",
  "Adres tegenpartij",
  "gestructureerde mededeling",
  "Vrije mededeling",
];

export const KBC_ROWS: Record<string, string>[] = [
  {
    Rekeningnummer: "BE00000000000000",
    Naam: "EXAMPLE BV",
    Munt: "EUR",
    Afschriftnummer: "02026101",
    Datum: "03/11/2026",
    Omschrijving: "EUROPESE DOMICILIERING VAN EXAMPLE TELECOM NV",
    Valuta: "03/11/2026",
    Bedrag: "-59,29",
    Saldo: "1.234,56",
    debet: "-59,29",
    "rekeningnummer tegenpartij": "BE11111111111111",
    "Naam tegenpartij": "Example Telecom NV",
  },
  {
    Rekeningnummer: "BE00000000000000",
    Naam: "EXAMPLE BV",
    Munt: "EUR",
    Afschriftnummer: "02026102",
    Datum: "04/11/2026",
    Omschrijving: "OVERSCHRIJVING VAN EXAMPLE CLIENT BV",
    Valuta: "04/11/2026",
    Bedrag: "1.500,00",
    Saldo: "2.734,56",
    credit: "1.500,00",
    "Naam tegenpartij": "Example Client BV",
  },
];
