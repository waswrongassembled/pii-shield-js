import { describe, expect, it } from 'vitest';

import {
  AtSvnrDetector,
  BirthDateDetector,
  type Detector,
  EmailDetector,
  EntityType,
  FileNumberDetector,
  IbanDetector,
  LicensePlateDetector,
  PhoneDetector,
  PostalAddressDetector,
  SalutationPersonDetector,
  TaxNumberDetector,
} from '../src/index.js';
import { isInLetterhead } from '../src/detectors/authority-context.js';
import { matchAll } from '../src/internal/pcre.js';
import { expectedEntity, loadFixture, type Described } from './support/fixtures.js';

const svnr = new AtSvnrDetector();
const iban = new IbanDetector();
const tax = new TaxNumberDetector();
const email = new EmailDetector();
const phone = new PhoneDetector();
const birth = new BirthDateDetector();
const file = new FileNumberDetector();
const plate = new LicensePlateDetector();
const person = new SalutationPersonDetector();
const address = new PostalAddressDetector();

// Ported from tests/Detector/DetectorTest.php (detectionProvider).
const detection: [string, Detector, string, string[]][] = [
  // SVNR
  ['svnr: valid with space', svnr, 'SVNR: 4568 150392.', ['4568 150392']],
  ['svnr: valid compact', svnr, 'Nr. 1237010180', ['1237010180']],
  ['svnr: wrong check digit', svnr, 'SVNR 1234 010180', []],
  ['svnr: with hyphen', svnr, 'SVNR 4568-150392', ['4568-150392']],
  ['svnr: split across lines', svnr, 'SVNR 4568\n150392', ['4568\n150392']],
  ['svnr: hyphen needs a birth date', svnr, 'Unser Zeichen: VWA-2026-100084, bitte angeben', []],
  ['svnr: line break needs a birth date', svnr, 'Dornbirn, am 12.03.2026\n100084 Euro sind offen', []],
  ['svnr: year of a date is no SVNR start', svnr, 'Dornbirn, am 12.03.2026\n150392 Euro sind offen', []],
  ['svnr: part of longer number', svnr, 'Konto 912370101801', []],

  // IBAN
  ['iban: grouped', iban, 'IBAN AT61 1904 3002 3457 3201, danke', ['AT61 1904 3002 3457 3201']],
  ['iban: compact DE', iban, 'auf DE89370400440532013000 überweisen', ['DE89370400440532013000']],
  ['iban: followed by uppercase word', iban, 'AT61 1904 3002 3457 3201 BIC', ['AT61 1904 3002 3457 3201']],
  ['iban: split across lines', iban, 'IBAN AT61 1904 3002\n3457 3201, danke', ['AT61 1904 3002\n3457 3201']],
  ['iban: BIC on the next line', iban, 'AT61 1904 3002 3457 3201\nBKAUATWW', ['AT61 1904 3002 3457 3201']],
  ['iban: invalid checksum', iban, 'AT62 1904 3002 3457 3201', []],

  // Tax numbers
  ['tax: AT Steuernummer', tax, 'Steuernummer: 46 123/4567', ['46 123/4567']],
  ['tax: DE Steuernummer', tax, 'StNr. 181/815/08155', ['181/815/08155']],
  ['tax: DE Steuer-ID valid', tax, 'Steuer-ID 86095742719', ['86095742719']],
  ['tax: DE Steuer-ID invalid', tax, 'Steuer-ID 86095742718', []],
  ['tax: amount is no tax number', tax, 'Betrag 1.245,00 Euro', []],
  [
    'tax: several, in text order',
    tax,
    'Steuer-ID 86095742719\nStNr. 181/815/08155\nSteuer-ID 24051867317',
    ['86095742719', '181/815/08155', '24051867317'],
  ],

  // Email
  ['email: private', email, 'Kontakt: maria.musterfrau@example.com', ['maria.musterfrau@example.com']],
  ['email: authority contact kept', email, 'Der Einspruch ist per E-Mail an post@bh.example einzubringen.', []],
  [
    'email: several private',
    email,
    'maria@example.org und johann@example.org',
    ['maria@example.org', 'johann@example.org'],
  ],
  [
    'email: private after an authority contact',
    email,
    'Einspruch an post@bh.example einzubringen.\nPrivat: maria@example.org',
    ['maria@example.org'],
  ],
  [
    'email: authority keyword on another line',
    email,
    'Finanzamt Linz\nKontakt: maria@example.org\nBescheid vom Finanzamt',
    ['maria@example.org'],
  ],
  [
    'email: authority keyword in another sentence of the line',
    email,
    'Ihr Einspruch ist eingelangt. Ihre Adresse maria@example.org wurde gespeichert.',
    ['maria@example.org'],
  ],
  [
    'email: first person singular is the writer, not the authority',
    email,
    'Gegen den Bescheid erhebe ich Einspruch. Sie erreichen mich unter johann.beispielmann@example.at.',
    ['johann.beispielmann@example.at'],
  ],
  [
    'email: "Ihre E-Mail-Adresse" is the recipient\'s',
    email,
    'Ihre E-Mail-Adresse maria@example.org haben wir gespeichert.',
    ['maria@example.org'],
  ],
  [
    'email: case worker in first person, authority domain under gv.at',
    email,
    'Bezirkshauptmannschaft Musterstadt\nVerkehrsamt\n\nFrau\nMaria Musterfrau\n\nSie erreichen mich unter verkehr@bh-musterstadt.gv.at.',
    [],
  ],
  [
    'email: authority contact redacted when disabled',
    new EmailDetector({ keepAuthorityContacts: false }),
    'Bitte kontaktieren Sie uns unter post@bh.example.',
    ['post@bh.example'],
  ],

  // Phone
  ['phone: international', phone, 'Mobil: +43 664 1234567', ['+43 664 1234567']],
  ['phone: national', phone, 'Tel. 0664/1234567', ['0664/1234567']],
  ['phone: authority hotline kept', phone, 'Bei Fragen erreichen Sie uns unter +43 50 233 233.', []],
  [
    'phone: several private',
    phone,
    'Mobil +43 664 1234567, Festnetz 05572 123456',
    ['+43 664 1234567', '05572 123456'],
  ],
  [
    'phone: private after an authority hotline',
    phone,
    'Erreichen Sie uns unter +43 50 233 233.\nPrivat: 0664/1234567',
    ['0664/1234567'],
  ],
  [
    'phone: authority keyword in another sentence of the line',
    phone,
    'Gegen den Bescheid haben Sie Einspruch erhoben. Ihre Telefonnummer lautet 0664/1234567.',
    ['0664/1234567'],
  ],
  [
    'phone: abbreviations do not end the sentence',
    phone,
    'Bezirkshauptmannschaft Musterstadt, Abt. Verkehr, Tel. 05572 12345',
    [],
  ],
  [
    'phone: authority hotline after an earlier sentence',
    phone,
    'Bitte beachten Sie die Frist. Bei Fragen erreichen Sie uns unter Tel. 05572 12345.',
    [],
  ],
  [
    'phone: mobile number is never an authority contact',
    phone,
    'Ihren Einspruch haben wir unter 0664 1234567 notiert.',
    ['0664 1234567'],
  ],
  [
    'phone: international mobile number is never an authority contact',
    phone,
    'Laut unserer Unterlagen sind Sie unter +43 664 1234567 erreichbar.',
    ['+43 664 1234567'],
  ],
  [
    'phone: first person singular is the writer, not the authority',
    phone,
    'Gegen den Bescheid erhebe ich Einspruch. Sie erreichen mich unter 05572 12345.',
    ['05572 12345'],
  ],
  [
    'phone: mobile number with trunk zero after the country code',
    phone,
    'Ihren Einspruch haben wir unter +43 0664 1234567 notiert.',
    ['+43 0664 1234567'],
  ],
  [
    'phone: "Ihre Telefonnummer" is the recipient\'s',
    phone,
    'Ihre Telefonnummer 05572 12345 haben wir gespeichert.',
    ['05572 12345'],
  ],
  [
    'phone: authority hotline with "Ihrem Bescheid" kept',
    phone,
    'Bei Fragen zu Ihrem Bescheid erreichen Sie uns unter 05572 12345.',
    [],
  ],
  [
    'phone: Salzburg landline is no mobile',
    phone,
    'Rückfragen richten Sie bitte an das Magistrat Salzburg, Tel. 0662 8072 2000.',
    [],
  ],
  [
    'phone: Salzburg landline with country code is no mobile',
    phone,
    'Rückfragen richten Sie bitte an das Magistrat Salzburg, Tel. +43 662 8072 2000.',
    [],
  ],
  ['phone: Pinzgau landline is no mobile', phone, 'Bei Fragen erreichen Sie uns unter 06542 7860.', []],
  ['phone: Upper Austrian landline is no mobile', phone, 'Bei Fragen erreichen Sie uns unter 07612 7920.', []],
  ['phone: Vienna landline is no mobile', phone, 'Bei Fragen erreichen Sie uns unter 01 514 33.', []],
  ['phone: Frankfurt landline is no mobile', phone, 'Bei Fragen erreichen Sie uns unter 069 212 0.', []],
  [
    'phone: German mobile with country code',
    phone,
    'Ihren Einspruch haben wir unter +49 151 2345678 notiert.',
    ['+49 151 2345678'],
  ],
  [
    'phone: case worker in first person is kept',
    phone,
    'Für Rückfragen zu Ihrem Einspruch stehe ich Ihnen unter 05572 306 1234 zur Verfügung.',
    [],
  ],
  [
    'phone: "Ihrer E-Mail vom" does not make it personal',
    phone,
    'Bezüglich Ihrer E-Mail vom 01.02.2026 erreichen Sie uns unter 05572 306 0.',
    [],
  ],
  [
    'phone: "Meinung" is no first person',
    phone,
    'Nach unserer Meinung erreichen Sie uns am besten unter 05572 306 0.',
    [],
  ],
  [
    'phone: "Ihre Rufnummer" is the recipient\'s',
    phone,
    'Wir haben Ihren Einspruch erhalten, Ihre Rufnummer 05572 45678 ist vermerkt.',
    ['05572 45678'],
  ],
  ['phone: seven digits are enough', phone, 'Tel. 0664 123', ['0664 123']],
  ['phone: six digits are not', phone, 'Tel. 0664 12', []],
  ['phone: time is no phone', phone, 'um 07:42 Uhr', []],
  ['phone: date is no phone', phone, 'am 02.11.2026', []],

  // Birth date
  ['birth date: geb.', birth, 'geb. 15.03.1992', ['15.03.1992']],
  ['birth date: geboren am', birth, 'geboren am 1.3.1980 in Linz', ['1.3.1980']],
  ['birth date: Geburtsdatum', birth, 'Geburtsdatum: 01.01.1970', ['01.01.1970']],
  ['birth date: geb. am', birth, 'geb. am 15.03.1992', ['15.03.1992']],
  ['birth date: Geburtsdatum without colon', birth, 'Geburtsdatum 01.01.1970', ['01.01.1970']],
  ['birth date: deadline is kept', birth, 'fällig am 15.11.2026', []],
  ['birth date: impossible date', birth, 'geb. 31.02.1992', []],

  // File numbers
  ['file number: Zahl', file, 'Zahl: BHMS-VK-2026/48213\n', ['BHMS-VK-2026/48213']],
  ['file number: Verwendungszweck', file, 'Verwendungszweck: BHMS-VK-2026/48213.', ['BHMS-VK-2026/48213']],
  ['file number: Kundennummer', file, 'Kundennummer 4711-0815', ['4711-0815']],
  ['file number: without digits', file, 'Verwendungszweck: Ihre Steuernummer', []],
  ['file number: no keyword', file, 'Buchungsmitteilung Nr. 3/2026', []],

  // License plates
  ['plate: AT', plate, 'mit dem Kennzeichen B-123AB die', ['B-123AB']],
  ['plate: DE', plate, 'Kennzeichen: M-AB 1234.', ['M-AB 1234']],
  ['plate: no keyword', plate, 'Straße L 200 bei Strkm 4,2', []],

  // Persons (salutation heuristic)
  ['person: address block', person, 'Frau\nMaria Musterfrau\nLindenweg 12', ['Maria Musterfrau']],
  ['person: address block with title', person, 'Herrn\nDr. Johann Beispielmann\n', ['Johann Beispielmann']],
  ['person: inline salutation', person, 'Sehr geehrter Herr Beispielmann,', ['Beispielmann']],
  ['person: inline first and last name', person, 'wie mit Frau Maria Musterfrau besprochen', ['Maria Musterfrau']],
  // Known trade-off: a following noun is indistinguishable from a surname without NER.
  [
    'person: inline over-redacts following noun',
    person,
    'Herr Beispielmann Bescheid gegeben',
    ['Beispielmann Bescheid'],
  ],
  ['person: inline takes at most two words', person, 'Frau Maria Anna Musterfrau', ['Maria Anna']],
  ['person: inline name with non-German capital', person, 'Sehr geehrte Frau Čermáková,', ['Čermáková']],
  ['person: address block with non-German capitals', person, 'Herrn\nŽeljko Šarić\nLindenweg 12', ['Željko Šarić']],
  ['person: no salutation', person, 'Mag. Thomas Beispiel', []],
  ['person: OCR blank line after salutation', person, 'Frau\n\nMaria Musterfrau\nLindenweg 12', ['Maria Musterfrau']],
  [
    'person: OCR split first name',
    person,
    'Herrn\n\nJ ohann Beispielmann\n\nBahnhofstraße 7/3',
    ['J ohann Beispielmann'],
  ],
  ['person: OCR blank lines, at most two', person, 'Frau\n\n\n\nMaria Musterfrau', []],
  [
    'person: salutation ending a line in running text',
    person,
    'Das haben wir mit unserem Herrn\n\nBitte zahlen Sie bis Ende',
    [],
  ],
  ['person: lone salutation before lower-case text', person, 'Frau\n\nbitte beachten Sie', []],

  // Postal addresses
  ['address: street and city', address, 'Lindenweg 12\n6900 Bregenz\n', ['Lindenweg 12\n6900 Bregenz']],
  ['address: door number', address, 'Bahnhofstraße 7/3\n4020 Linz', ['Bahnhofstraße 7/3\n4020 Linz']],
  ['address: DE postcode', address, 'Musterallee 5a\n10115 Berlin', ['Musterallee 5a\n10115 Berlin']],
  ['address: street with non-German capital', address, 'Šumavská 12\n6900 Bregenz', ['Šumavská 12\n6900 Bregenz']],
  ['address: single line letterhead kept', address, 'Hauptplatz 1, 6999 Musterstadt', []],
  [
    'address: OCR blank line before city',
    address,
    'Bahnhofstraße 7/3\n\n4020 Linz\n',
    ['Bahnhofstraße 7/3\n\n4020 Linz'],
  ],
  [
    'address: OCR two blank lines before city',
    address,
    'Lindenweg 12\n\n\n6900 Bregenz',
    ['Lindenweg 12\n\n\n6900 Bregenz'],
  ],
  ['address: separate paragraphs are no address', address, 'Rechtsmittelfrist 14\n\n\n\n6900 Bregenz', []],
];

describe('detectors', () => {
  it.each(detection)('%s', (_case, detector, text, expected) => {
    expect(detector.detect(text).map((e) => e.value)).toEqual(expected);
  });

  it('reports offsets that slice the value out of the text', () => {
    const text = '😀 Grüße aus Österreich\nSehr geehrter Herr Beispielmann, Ihre SVNR lautet 4568 150392.';
    const entities = [person, svnr].flatMap((d) => d.detect(text));

    expect(entities).toHaveLength(2);
    for (const e of entities) {
      expect(text.slice(e.offset, e.offset + e.value.length)).toBe(e.value);
    }
  });

  it('entities carry type and detector name', () => {
    expect(svnr.detect('4568 150392')).toEqual([
      { type: EntityType.AtSvnr, value: '4568 150392', offset: 0, confidence: 1, detector: 'at_svnr' },
    ]);
  });

  it('accepts a custom validator', () => {
    const detector = new IbanDetector({ validator: (candidate) => candidate.startsWith('AT62') });

    expect(detector.detect('AT62 1904 3002 3457 3201').map((e) => e.value)).toEqual(['AT62 1904 3002 3457 3201']);
  });
});

describe('isInLetterhead', () => {
  const text = 'Bezirkshauptmannschaft Musterstadt\nVerkehrsamt\n\nFrau\nMaria Musterfrau';

  it.each([
    [text, 0, true],
    [text, text.indexOf('Verkehrsamt'), true],
    [text, text.indexOf('Frau'), false],
    ['Verein Musterstadt\nVerkehr\n\nFrau\nMaria Musterfrau', 0, false],
  ])('%j at %i → %s', (input, offset, expected) => {
    expect(isInLetterhead(input, offset)).toBe(expected);
  });
});

// Ported from tests/Detector/RegexMatcherTest.php; offsets are UTF-16 indices here.
describe('matchAll', () => {
  it('returns values with their offsets', () => {
    expect(matchAll(/x@y\.at|z/gu, 'ab\nÄrger x@y.at\n\nz')).toEqual([
      { value: 'x@y.at', offset: 9 },
      { value: 'z', offset: 17 },
    ]);
  });

  it('returns group offsets in later matches and skips unmatched groups', () => {
    expect(matchAll(/Ä(?<w>\w+)|x(?<w2>@)/dgu, 'Äb Äc x@', 'w')).toEqual([
      { value: 'b', offset: 1 },
      { value: 'c', offset: 4 },
    ]);
  });
});

const factories: Record<string, (options: Described['options']) => Detector> = {
  AtSvnrDetector: () => new AtSvnrDetector(),
  IbanDetector: () => new IbanDetector(),
  TaxNumberDetector: () => new TaxNumberDetector(),
  EmailDetector: (o) => new EmailDetector({ keepAuthorityContacts: o['keepAuthorityContacts'] !== false }),
  PhoneDetector: (o) => new PhoneDetector({ keepAuthorityContacts: o['keepAuthorityContacts'] !== false }),
  BirthDateDetector: () => new BirthDateDetector(),
  FileNumberDetector: () => new FileNumberDetector(),
  LicensePlateDetector: () => new LicensePlateDetector(),
  SalutationPersonDetector: () => new SalutationPersonDetector(),
  PostalAddressDetector: () => new PostalAddressDetector(),
};

describe('PHP parity (fixtures/detectors.json)', () => {
  it.each(loadFixture('detectors').cases)('$detector.class: $case', ({ detector, text, entities }) => {
    const create = factories[detector.class];

    expect(create, `no factory for ${detector.class}`).toBeDefined();
    expect(create?.(detector.options).detect(text)).toStrictEqual(entities.map((e) => expectedEntity(text, e)));
  });
});
