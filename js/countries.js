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
        const modern = HISTORICAL_TO_MODERN[code];
        if (modern) {
            if (!map[modern]) map[modern] = { own: [], historical: {} };
            map[modern].historical[code] = (map[modern].historical[code] || []).concat(c.images);
        } else {
            if (!map[code]) map[code] = { own: [], historical: {} };
            map[code].own = map[code].own.concat(c.images);
        }
    });
    return map;
}

export function countryTotalCount(entry) {
    return entry.own.length +
        Object.values(entry.historical).reduce((s, arr) => s + arr.length, 0);
}

// Counts each physical note ONCE across the whole collection. A note shared
// between countries by the currency-merge feature carries the same Drive file
// id in every one of them, so summing per-country counts would count it many
// times. Per-country counts are deliberately left as they are.
export function uniqueImageCount(countryMap) {
    const ids = new Set();
    Object.values(countryMap).forEach(entry => {
        entry.own.forEach(img => ids.add(img.id));
        Object.values(entry.historical).forEach(arr => arr.forEach(img => ids.add(img.id)));
    });
    return ids.size;
}
