/* My Account field rules. The theme runs the same checks first
   (theme_export/snippets/account-validate.liquid) - change both together.
   Every failure is keyed by the page's data-acct-field name so the page can
   put the message under that one field. */

const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
  GU: "Guam", VI: "Virgin Islands", AS: "American Samoa", MP: "Northern Mariana Islands",
  AA: "Armed Forces Americas", AE: "Armed Forces Europe", AP: "Armed Forces Pacific",
};
const CA_PROVINCES = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut",
  ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};
const IS_US = /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i;
const IS_CA = /^(ca|can|canada)$/i;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;
const PLACE_RE = /^[\p{L}\p{M}][\p{L}\p{M}' .()-]*$/u;
const ADDRESS_KEYS = ["address1", "address2", "city", "province", "zip", "country"];

const inList = (map, v) => {
  const s = String(v || "").trim().toLowerCase();
  return Object.keys(map).some((k) => k.toLowerCase() === s || map[k].toLowerCase() === s);
};

/** "+13125550199" for Shopify, "" when empty, null when it can't be made
 *  valid. A plain 10-digit number is taken as US/Canada (+1). */
export function normalizePhone(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";
  if (/[^\d\s()+.-]/.test(raw) || raw.indexOf("+", 1) > -1) return null;
  const digits = raw.replace(/\D/g, "");
  let full;
  if (raw.startsWith("+")) full = "+" + digits;
  else if (digits.length === 10) full = "+1" + digits;
  else if (digits.length === 11 && digits.startsWith("1")) full = "+" + digits;
  else return null;
  if (!/^\+[1-9]\d{7,14}$/.test(full)) return null;
  if (full.startsWith("+1") && full.length !== 12) return null;
  return full;
}

export function phoneMessage(v) {
  const raw = String(v || "").trim();
  if (/[^\d\s()+.-]/.test(raw)) return "Phone can only contain digits, spaces, +, -, ( ) and periods.";
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+1") || (!raw.startsWith("+") && digits.length <= 11)) {
    return "Enter a 10-digit US/Canada number (e.g. 312-555-0199), or add the country code for other countries (e.g. +44 20 7946 0958).";
  }
  return "Enter a valid phone number with country code, e.g. +44 20 7946 0958.";
}

function zipMessage(zip, country) {
  const z = String(zip || "").trim();
  if (IS_US.test(country)) return /^\d{5}(-\d{4})?$/.test(z) ? "" : "Enter a valid US ZIP code, e.g. 11201 or 11201-1234.";
  if (IS_CA.test(country)) return /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(z) ? "" : "Enter a valid Canadian postal code, e.g. K1A 0B1.";
  if (/^india$/i.test(country)) return /^\d{6}$/.test(z) ? "" : "Enter a valid 6-digit PIN code, e.g. 110001.";
  if (/^australia$/i.test(country)) return /^\d{4}$/.test(z) ? "" : "Enter a valid 4-digit postcode, e.g. 2000.";
  if (/^(united kingdom|uk|great britain|england|scotland|wales)$/i.test(country)) {
    return /^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/.test(z) ? "" : "Enter a valid UK postcode, e.g. SW1A 1AA.";
  }
  return /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(z) ? "" : "Enter a valid ZIP / postal code (letters, digits, spaces or hyphens).";
}

function nameMessage(label, v) {
  if (!v) return `${label} is required.`;
  if (v.length > 50) return `${label} must be 50 characters or fewer.`;
  if (!NAME_RE.test(v)) return `${label} can only contain letters, spaces, hyphens (-), apostrophes (') and periods.`;
  return "";
}

export function validatePersonal(payload) {
  const v = (k) => String(payload[k] ?? "").trim();
  const errs = {};
  const set = (k, msg) => { if (msg && !errs[k]) errs[k] = msg; };
  set("firstName", nameMessage("First Name", v("firstName")));
  set("lastName", nameMessage("Last Name", v("lastName")));
  const email = v("email");
  if (!email) set("email", "Email is required.");
  else if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/.test(email)) {
    set("email", "Enter a valid email address, e.g. name@example.com.");
  }
  if (v("phone") && normalizePhone(v("phone")) === null) set("phone", phoneMessage(v("phone")));
  return errs;
}

export function validateAddress(payload) {
  const v = (k) => String(payload[k] ?? "").trim();
  const errs = {};
  const set = (k, msg) => { if (msg && !errs[k]) errs[k] = msg; };
  if (v("company").length > 100) set("company", "Clinic / Business Name must be 100 characters or fewer.");
  // optional - but once any part is filled in it has to be complete and real
  if (!ADDRESS_KEYS.some((k) => v(k))) return errs;

  const country = v("country");
  const address1 = v("address1");
  if (!address1) set("address1", "Address Line 1 is required.");
  else if (address1.length < 3 || !/[A-Za-z0-9]/.test(address1)) set("address1", "Enter a street address, e.g. 345 Adams Street.");
  else if (address1.length > 100) set("address1", "Address Line 1 must be 100 characters or fewer.");
  if (v("address2").length > 100) set("address2", "Address Line 2 must be 100 characters or fewer.");

  const city = v("city");
  if (!city) set("city", "City is required.");
  else if (city.length > 60 || !PLACE_RE.test(city)) set("city", "City can only contain letters, spaces, hyphens (-), apostrophes (') and periods.");

  if (!country) set("country", "Country is required.");
  else if (country.length > 60 || !PLACE_RE.test(country)) set("country", "Enter a valid country name, e.g. United States.");

  const province = v("province");
  if (IS_US.test(country)) {
    if (!province) set("province", "State is required for United States addresses.");
    else if (!inList(US_STATES, province)) set("province", "Enter a valid US state, e.g. New York or NY.");
  } else if (IS_CA.test(country)) {
    if (!province) set("province", "Province is required for Canadian addresses.");
    else if (!inList(CA_PROVINCES, province)) set("province", "Enter a valid Canadian province, e.g. Ontario or ON.");
  } else if (province && (province.length > 60 || !PLACE_RE.test(province))) {
    set("province", "State / Province can only contain letters, spaces, hyphens and periods.");
  }

  if (!v("zip")) set("zip", "ZIP / Postal Code is required.");
  else set("zip", zipMessage(v("zip"), country));
  return errs;
}

/* ------------------------------ banking details ------------------------- */
// Same rules in the theme (window.rxBanking, snippets/account-validate.liquid).
// Payouts go out by ACH, so the bank and the account holder are US addresses.

/** ABA routing number: 9 digits with a valid check digit. */
export function validRouting(v) {
  if (!/^\d{9}$/.test(v)) return false;
  const d = v.split("").map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

const ORG_RE = /^[\p{L}\p{M}0-9][\p{L}\p{M}0-9 .,&'()/#-]*$/u;

function bankAddressErrors(errs, v, prefix, label) {
  const set = (k, msg) => { if (msg && !errs[k]) errs[k] = msg; };
  const a1 = v(`${prefix}_address_1`);
  if (!a1) set(`${prefix}_address_1`, `${label} Address 1 is required.`);
  else if (a1.length < 3 || !/[A-Za-z0-9]/.test(a1)) set(`${prefix}_address_1`, "Enter a street address, e.g. 345 Adams Street.");
  else if (a1.length > 100) set(`${prefix}_address_1`, `${label} Address 1 must be 100 characters or fewer.`);
  if (v(`${prefix}_address_2`).length > 100) set(`${prefix}_address_2`, `${label} Address 2 must be 100 characters or fewer.`);
  const city = v(`${prefix}_city`);
  if (!city) set(`${prefix}_city`, `${label} City is required.`);
  else if (city.length > 60 || !PLACE_RE.test(city)) set(`${prefix}_city`, "City can only contain letters, spaces, hyphens (-), apostrophes (') and periods.");
  const state = v(`${prefix}_state`);
  if (!state) set(`${prefix}_state`, `${label} State is required.`);
  else if (!inList(US_STATES, state)) set(`${prefix}_state`, "Enter a valid US state, e.g. New York or NY.");
  const zip = v(`${prefix}_zip_postal`);
  if (!zip) set(`${prefix}_zip_postal`, `${label} ZIP code is required.`);
  else if (!/^\d{5}(-\d{4})?$/.test(zip)) set(`${prefix}_zip_postal`, "Enter a valid US ZIP code, e.g. 11201 or 11201-1234.");
}

/** Banking form checks keyed by the form's field names (snake_case). */
export function validateBanking(fields) {
  const v = (k) => String(fields[k] ?? "").trim();
  const errs = {};
  const set = (k, msg) => { if (msg && !errs[k]) errs[k] = msg; };

  const bank = v("bank_name");
  if (!bank) set("bank_name", "Bank Name is required.");
  else if (bank.length < 2 || bank.length > 100 || !ORG_RE.test(bank)) set("bank_name", "Enter the bank's name, e.g. Chase Bank (letters, digits, spaces and . , & ' - only).");

  const routing = v("bank_routing_ach").replace(/[\s-]/g, "");
  if (!routing) set("bank_routing_ach", "Bank Routing (ACH) is required.");
  else if (!/^\d{9}$/.test(routing)) set("bank_routing_ach", "The routing number must be exactly 9 digits.");
  else if (!validRouting(routing)) set("bank_routing_ach", "This is not a valid ABA routing number - please double-check it with your bank.");

  const acct = v("bank_holder_account_number").replace(/[\s-]/g, "");
  if (!acct) set("bank_holder_account_number", "Account Number is required.");
  else if (!/^\d{4,17}$/.test(acct)) set("bank_holder_account_number", "The account number must be 4 to 17 digits (numbers only).");

  bankAddressErrors(errs, v, "bank", "Bank");

  const biz = v("account_holder_business_name");
  if (!biz) set("account_holder_business_name", "Account Holder Business Name is required.");
  else if (biz.length < 2 || biz.length > 100 || !ORG_RE.test(biz)) {
    set("account_holder_business_name", "Enter the business name on the account (letters, digits, spaces and . , & ' - only).");
  }

  bankAddressErrors(errs, v, "account_holder", "Account Holder");

  const phone = v("account_holder_phone");
  if (!phone) set("account_holder_phone", "Account Holder Phone is required.");
  else if (normalizePhone(phone) === null) set("account_holder_phone", phoneMessage(phone));
  return errs;
}
