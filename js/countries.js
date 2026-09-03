// Country reference data and the pure helpers that work on it.

export const COUNTRY_NAMES = {
            'AFG': 'Afghanistan', 'ALB': 'Albania', 'DZA': 'Algeria', 'AND': 'Andorra',
            'AGO': 'Angola', 'ARG': 'Argentina', 'ARM': 'Armenia', 'AUS': 'Australia',
            'AUT': 'Austria', 'AZE': 'Azerbaijan', 'BHS': 'Bahamas', 'BHR': 'Bahrain',
            'BGD': 'Bangladesh', 'BRB': 'Barbados', 'BLR': 'Belarus', 'BEL': 'Belgium',
            'BLZ': 'Belize', 'BEN': 'Benin', 'BTN': 'Bhutan', 'BOL': 'Bolivia',
            'BIH': 'Bosnia and Herzegovina', 'BWA': 'Botswana', 'BRA': 'Brazil',
            'BRN': 'Brunei', 'BGR': 'Bulgaria', 'BFA': 'Burkina Faso', 'BDI': 'Burundi',
            'KHM': 'Cambodia', 'CMR': 'Cameroon', 'CAN': 'Canada', 'CPV': 'Cabo Verde',
            'CAF': 'Central African Republic', 'TCD': 'Chad', 'CHL': 'Chile',
            'CHN': 'China', 'COL': 'Colombia', 'COM': 'Comoros', 'COG': 'Congo',
            'CRI': 'Costa Rica', 'HRV': 'Croatia', 'CUB': 'Cuba', 'CYP': 'Cyprus',
            'CZE': 'Czech Republic', 'CSK': 'Czechoslovakia', 'DNK': 'Denmark',
            'DJI': 'Djibouti', 'DOM': 'Dominican Republic', 'DDR': 'East Germany',
            'ECU': 'Ecuador', 'EGY': 'Egypt', 'SLV': 'El Salvador',
            'GNQ': 'Equatorial Guinea', 'ERI': 'Eritrea', 'EST': 'Estonia',
            'SWZ': 'Eswatini', 'ETH': 'Ethiopia', 'FJI': 'Fiji', 'FIN': 'Finland',
            'FRA': 'France', 'GAB': 'Gabon', 'GMB': 'Gambia', 'GEO': 'Georgia',
            'DEU': 'Germany', 'GHA': 'Ghana', 'GRC': 'Greece', 'GTM': 'Guatemala',
            'GIN': 'Guinea', 'GNB': 'Guinea-Bissau', 'GUY': 'Guyana', 'HTI': 'Haiti',
            'HND': 'Honduras', 'HKG': 'Hong Kong', 'HUN': 'Hungary', 'ISL': 'Iceland',
            'IND': 'India', 'IDN': 'Indonesia', 'IRN': 'Iran', 'IRQ': 'Iraq',
            'IRL': 'Ireland', 'ISR': 'Israel', 'ITA': 'Italy', 'CIV': 'Ivory Coast',
            'JAM': 'Jamaica', 'JPN': 'Japan', 'JOR': 'Jordan', 'KAZ': 'Kazakhstan',
            'KEN': 'Kenya', 'PRK': 'Korea (North)', 'KOR': 'Korea (South)',
            'KWT': 'Kuwait', 'KGZ': 'Kyrgyzstan', 'LAO': 'Laos', 'LVA': 'Latvia',
            'LBN': 'Lebanon', 'LBY': 'Libya', 'LTU': 'Lithuania', 'LUX': 'Luxembourg',
            'MAC': 'Macau', 'MDG': 'Madagascar', 'MYS': 'Malaysia', 'MDV': 'Maldives',
            'MLI': 'Mali', 'MLT': 'Malta', 'MEX': 'Mexico', 'MDA': 'Moldova',
            'MNG': 'Mongolia', 'MAR': 'Morocco', 'MOZ': 'Mozambique', 'MMR': 'Myanmar',
            'NPL': 'Nepal', 'NLD': 'Netherlands', 'NZL': 'New Zealand',
            'NIC': 'Nicaragua', 'NGA': 'Nigeria', 'NIR': 'Northern Ireland',
            'NOR': 'Norway', 'OMN': 'Oman', 'PAK': 'Pakistan', 'PSE': 'Palestine',
            'PAL': 'Palestine (Mandatory)', 'PAN': 'Panama', 'PRY': 'Paraguay',
            'PER': 'Peru', 'PHL': 'Philippines', 'POL': 'Poland', 'PRT': 'Portugal',
            'QAT': 'Qatar', 'ROU': 'Romania', 'RUS': 'Russia', 'SAU': 'Saudi Arabia',
            'SRB': 'Serbia', 'SGP': 'Singapore', 'SVK': 'Slovakia', 'SVN': 'Slovenia',
            'ZAF': 'South Africa', 'SUN': 'USSR (Soviet Union)', 'ESP': 'Spain',
            'LKA': 'Sri Lanka', 'SDN': 'Sudan', 'SWE': 'Sweden', 'CHE': 'Switzerland',
            'SYR': 'Syria', 'TWN': 'Taiwan', 'THA': 'Thailand', 'PRB': 'Transnistria',
            'TUN': 'Tunisia', 'TUR': 'Turkey', 'UKR': 'Ukraine',
            'ARE': 'United Arab Emirates', 'GBR': 'United Kingdom', 'USA': 'United States',
            'URY': 'Uruguay', 'UZB': 'Uzbekistan', 'VAT': 'Vatican City',
            'VEN': 'Venezuela', 'VNM': 'Vietnam', 'YEM': 'Yemen', 'YUG': 'Yugoslavia',
            'ZWE': 'Zimbabwe', 'SLD': 'Somaliland', 'NKA': 'Nagorno-Karabakh',
            'FRO': 'Faroe Islands', 'SCT': 'Scotland', 'JEY': 'Jersey',
            'GGY': 'Guernsey', 'IMN': 'Isle of Man', 'GIB': 'Gibraltar',
            'FLK': 'Falkland Islands', 'SHN': 'Saint Helena', 'ABW': 'Aruba',
            'CUW': 'Curaçao', 'SXM': 'Sint Maarten', 'EUR': 'Eurozone',
            'WAF': 'Western Africa', 'MKD': 'North Macedonia', 'OTT': 'Ottoman Empire',

    // Added in v2.09: these all exist in countries.geojson but had no
    // English name here, so they showed as a bare 3-letter code in the
    // country modal and in exports. Four of them (MCO, SMR, KSV, MNE)
    // are referenced by the EUR group in multi_country_currencies.
    'AIA': 'Anguilla',
    'ALA': 'Aland',
    'ASM': 'American Samoa',
    'ATF': 'French Southern Territories',
    'ATG': 'Antigua and Barbuda',
    'BLM': 'Saint Barthelemy',
    'BMU': 'Bermuda',
    'COD': 'Congo (DR)',
    'COK': 'Cook Islands',
    'CYM': 'Cayman Islands',
    'CYN': 'Northern Cyprus',
    'DMA': 'Dominica',
    'ESH': 'Western Sahara',
    'FSM': 'Micronesia',
    'GRD': 'Grenada',
    'GRL': 'Greenland',
    'GUM': 'Guam',
    'HMD': 'Heard & McDonald Is.',
    'IOT': 'British Indian Ocean Terr.',
    'KIR': 'Kiribati',
    'KNA': 'Saint Kitts and Nevis',
    'KSV': 'Kosovo',
    'LBR': 'Liberia',
    'LCA': 'Saint Lucia',
    'LIE': 'Liechtenstein',
    'LSO': 'Lesotho',
    'MAF': 'Saint Martin',
    'MCO': 'Monaco',
    'MHL': 'Marshall Islands',
    'MNE': 'Montenegro',
    'MNP': 'Northern Mariana Islands',
    'MRT': 'Mauritania',
    'MSR': 'Montserrat',
    'MUS': 'Mauritius',
    'MWI': 'Malawi',
    'NAM': 'Namibia',
    'NCL': 'New Caledonia',
    'NER': 'Niger',
    'NFK': 'Norfolk Island',
    'NIU': 'Niue',
    'NRU': 'Nauru',
    'PCN': 'Pitcairn Islands',
    'PLW': 'Palau',
    'PNG': 'Papua New Guinea',
    'PRI': 'Puerto Rico',
    'PYF': 'French Polynesia',
    'RWA': 'Rwanda',
    'SEN': 'Senegal',
    'SGS': 'South Georgia',
    'SLB': 'Solomon Islands',
    'SLE': 'Sierra Leone',
    'SMR': 'San Marino',
    'SOM': 'Somalia',
    'SPM': 'Saint Pierre and Miquelon',
    'SSD': 'South Sudan',
    'STP': 'São Tomé and Principe',
    'SUR': 'Suriname',
    'SYC': 'Seychelles',
    'TCA': 'Turks and Caicos Islands',
    'TGO': 'Togo',
    'TJK': 'Tajikistan',
    'TKM': 'Turkmenistan',
    'TLS': 'East Timor',
    'TON': 'Tonga',
    'TTO': 'Trinidad and Tobago',
    'TUV': 'Tuvalu',
    'TZA': 'Tanzania',
    'UGA': 'Uganda',
    'UMI': 'US Minor Outlying Is.',
    'VCT': 'Saint Vincent',
    'VGB': 'British Virgin Islands',
    'VIR': 'United States Virgin Islands',
    'VUT': 'Vanuatu',
    'WLF': 'Wallis and Futuna',
    'WSM': 'Samoa',
    'ZMB': 'Zambia',
};

// Folder names that are really an alias for another code. Lets a folder you
// already named the old way keep working after a code is corrected.
export const CODE_ALIASES = {
    'CRC': 'CRI', // Costa Rica: CRC was wrong; ISO-3166-1 alpha-3 is CRI
};

export function canonicalCode(code) {
    const upper = String(code).toUpperCase();
    return CODE_ALIASES[upper] || upper;
}

// ---------- banknotes vs coins ----------
// The FOLDER NAME'S CASE says which a folder holds: "ISR" is Israeli
// banknotes, "isr" is Israeli coins. Both fold into the same country on the
// map - only what is shown, counted and coloured depends on which is selected.
//
// A mixed-case name says nothing either way, and is deliberately NOT guessed
// at: those images are shown in every mode, so nothing can quietly vanish from
// the app because a folder was named unexpectedly. The info panel reports how
// many there are so they can be renamed.
export const KIND_BANKNOTE = 'banknote';
export const KIND_COIN = 'coin';
export const KIND_UNKNOWN = 'unknown';

export function folderKind(name) {
    const s = String(name || '');
    if (s.toLowerCase() === s.toUpperCase()) return KIND_UNKNOWN; // no letters at all
    if (s === s.toUpperCase()) return KIND_BANKNOTE;
    if (s === s.toLowerCase()) return KIND_COIN;
    return KIND_UNKNOWN;
}

// itemType is 'both' | KIND_BANKNOTE | KIND_COIN.
export function imageMatchesType(img, itemType) {
    if (!itemType || itemType === 'both') return true;
    const kind = (img && img.kind) || KIND_UNKNOWN;
    if (kind === KIND_UNKNOWN) return true; // never hidden - see above
    return kind === itemType;
}

// A view of one country holding only the selected kind. Returns the entry
// itself when nothing is filtered out, so the common case allocates nothing.
export function filterEntry(entry, itemType) {
    if (!entry || !itemType || itemType === 'both') return entry;
    const own = entry.own.filter(img => imageMatchesType(img, itemType));
    const historical = {};
    Object.entries(entry.historical).forEach(([histCode, images]) => {
        const kept = images.filter(img => imageMatchesType(img, itemType));
        if (kept.length) historical[histCode] = kept;
    });
    return { own, historical };
}

export const HISTORICAL_TO_MODERN = {
            'SUN': 'RUS',  // USSR -> Russia
            'CSK': 'CZE',  // Czechoslovakia -> Czech Republic
            'DDR': 'DEU',  // East Germany -> Germany
            'YUG': 'SRB',  // Yugoslavia -> Serbia
            'PAL': 'ISR',  // Mandatory Palestine -> Israel
            'OTT': 'TUR',  // Ottoman Empire -> Turkey
        };

// Merges historical-entity folders (USSR, Ottoman Empire, ...) into the modern
// country whose territory they occupied, so they show as a labelled subsection
// instead of appearing as their own map entry.
export function buildCountryMap(countries) {
    const map = {};
    countries.forEach(c => {
        const code = canonicalCode(c.code);
        // Stamped here, from the folder the images came out of - by the time
        // "ISR" and "isr" have been merged into one country the case is gone,
        // so it has to be carried on the images themselves. Falling back to the
        // folder name keeps snapshots written before v2.17 working.
        const kind = c.kind || folderKind(c.code);
        const images = c.images.map(img =>
            (img && img.kind === kind) ? img : Object.assign({}, img, { kind }));
        const modern = HISTORICAL_TO_MODERN[code];
        if (modern) {
            if (!map[modern]) map[modern] = { own: [], historical: {} };
            map[modern].historical[code] = (map[modern].historical[code] || []).concat(images);
        } else {
            if (!map[code]) map[code] = { own: [], historical: {} };
            map[code].own = map[code].own.concat(images);
        }
    });
    return map;
}

export function countryTotalCount(entry, itemType) {
    const e = filterEntry(entry, itemType);
    return e.own.length +
        Object.values(e.historical).reduce((s, arr) => s + arr.length, 0);
}

// How many of each kind the whole collection holds, counting each physical
// item once. Shown in the info panel, where the "unclassified" figure is the
// prompt to rename a folder that is neither all-caps nor all-lowercase.
export function kindCounts(countryMap) {
    const seen = new Map(); // id -> kind
    Object.values(countryMap).forEach(entry => {
        const all = entry.own.concat(...Object.values(entry.historical));
        all.forEach(img => { if (!seen.has(img.id)) seen.set(img.id, img.kind || KIND_UNKNOWN); });
    });
    const counts = { [KIND_BANKNOTE]: 0, [KIND_COIN]: 0, [KIND_UNKNOWN]: 0 };
    seen.forEach(kind => { counts[kind] = (counts[kind] || 0) + 1; });
    return counts;
}

// Counts each physical note ONCE across the whole collection. A note shared
// between countries by the currency-merge feature carries the same Drive file
// id in every one of them, so summing per-country counts would count it many
// times. Per-country counts are deliberately left as they are.
export function uniqueImageCount(countryMap, itemType) {
    const ids = new Set();
    Object.values(countryMap).forEach(entry => {
        const e = filterEntry(entry, itemType);
        e.own.forEach(img => ids.add(img.id));
        Object.values(e.historical).forEach(arr => arr.forEach(img => ids.add(img.id)));
    });
    return ids.size;
}
