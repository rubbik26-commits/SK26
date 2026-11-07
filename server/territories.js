// Territory Mastery dataset. Six flagship territories carry a fully authored
// history, notable story, growth note and a researched $/sf trend; the rest
// resolve to live data by ZIP. Recovered verbatim from the production bundle.

export const TERRITORIES_AUTHORED = [
  {
    slug: "lic", label: "Long Island City", borough: "Queens",
    zips: ["11101","11102","11103","11104","11105","11106","11109"],
    defaultMode: "multifamily",
    keywords: ["lic","long island city","hunters point","court square","dutch kills","queens plaza","11101"],
    established: "Dutch farmland 1640s; incorporated as a city 1870; absorbed into Queens/NYC 1898.",
    tagline: "From Standard Oil refineries and bakeries to one of the fastest-growing residential skylines in the U.S.",
    history: [
      "Originally Dutch and English farmland on the East River across from Manhattan. Incorporated as its own City of Long Island City in 1870 — a patchwork of villages (Hunters Point, Astoria, Ravenswood, Dutch Kills, Blissville, Sunnyside) — before being folded into Greater New York in 1898.",
      "Industrialized hard in the late 1800s: the Long Island Rail Road terminus at Hunters Point, Standard Oil refineries, breweries, and food manufacturing. The Sunshine Biscuits bakery on the waterfront later became Silvercup Bakery, then Silvercup Studios.",
      "Manufacturing hollowed out mid-20th century, leaving a cheap, well-located warehouse district one subway stop from Midtown. The 2001 and 2008 rezonings (and Hunters Point South) unleashed the residential high-rise boom.",
      "By the 2010s LIC was among the fastest-growing neighborhoods in the country — thousands of rental units delivered, the waterfront reoriented from industry to residential, and free-market multifamily becoming the dominant institutional asset."
    ],
    notableStory: "The red 'Pepsi-Cola' sign on the Gantry Plaza waterfront — a 1940 relic of the bottling plant that once stood there — is now a NYC landmark, glowing in front of luxury towers. Silvercup Studios, in the old bakery, filmed The Sopranos, Sex and the City, and 30 Rock. In 2018 Amazon picked LIC for HQ2, then pulled out months later after political backlash — a saga that still frames every LIC conversation.",
    growth: "Population and housing stock surged after 2010 as rezoned waterfront parcels delivered tower after tower; Hunters Point went from rail yards and low-rise industry to a dense residential district in roughly a decade.",
    ppsfHistory: [ {year:2005,ppsf:350},{year:2010,ppsf:480},{year:2015,ppsf:750},{year:2020,ppsf:950},{year:2025,ppsf:1050} ]
  },
  {
    slug: "chelsea", label: "Chelsea", borough: "Manhattan",
    zips: ["10011","10001"], defaultMode: "multifamily",
    keywords: ["chelsea","west chelsea","high line","hudson yards edge","10011"],
    established: "Named for the country estate of Thomas Clarke, 1750; laid out as a neighborhood by Clement Clarke Moore in the 1820s–30s.",
    tagline: "Seminary row houses → Hudson piers and warehouses → gallery district → the High Line era.",
    history: [
      "The land was the Chelsea estate of British veteran Thomas Clarke (named after London's Chelsea). His grandson Clement Clarke Moore — the scholar credited with 'A Visit from St. Nicholas' ('Twas the Night Before Christmas') — divided it into building lots in the 1820s–30s and donated land to the General Theological Seminary, which still anchors the district.",
      "Greek Revival and Italianate row houses went up mid-1800s. The Hudson waterfront filled with piers, rail (the High Line freight viaduct opened 1934), warehouses and light manufacturing through the 20th century.",
      "As SoHo rents rose in the 1990s, art galleries migrated to West Chelsea's warehouse blocks, making it the city's gallery capital. The High Line's conversion to an elevated park (2009–2014) and the West Chelsea rezoning turned the far west side into a luxury and starchitect corridor feeding into Hudson Yards."
    ],
    notableStory: "The Hotel Chelsea on West 23rd has housed a century of bohemia — Mark Twain, Dylan Thomas (who collapsed here in 1953), Arthur Miller, Janis Joplin, Patti Smith and Robert Mapplethorpe, Leonard Cohen (who wrote 'Chelsea Hotel #2' about Janis Joplin), and Sid Vicious (where Nancy Spungen died in 1978). It reopened as a luxury hotel in 2022 after a decade of renovation fights.",
    growth: "Population stayed relatively flat (a built-out grid) but values re-rated dramatically post-High Line as warehouses converted and West Chelsea towers rose.",
    ppsfHistory: [ {year:2005,ppsf:900},{year:2010,ppsf:1150},{year:2015,ppsf:1700},{year:2020,ppsf:1900},{year:2025,ppsf:2050} ]
  },
  {
    slug: "harlem", label: "Harlem", borough: "Manhattan",
    zips: ["10026","10027","10030","10037","10039"], defaultMode: "multifamily",
    keywords: ["harlem","central harlem","sugar hill","strivers row","10027","10026"],
    established: "Founded as the Dutch village of Nieuw Haarlem in 1658.",
    tagline: "Dutch village → Gilded-Age suburb → capital of Black America and the Harlem Renaissance → 2000s revival.",
    history: [
      "Harlem began as Nieuw Haarlem, a Dutch farming village chartered in 1658, and stayed rural estates for two centuries. Rail and elevated lines in the late 1800s triggered a speculative building boom of brownstones and elevator apartment houses — much of it overbuilt.",
      "When that bubble burst, landlords opened the new housing to Black New Yorkers and Southern migrants during the Great Migration. By the 1920s Harlem was the cultural capital of Black America — the Harlem Renaissance — home to Langston Hughes, Zora Neale Hurston, Duke Ellington, and the Apollo Theater (1934) and Cotton Club.",
      "Mid-century disinvestment and the 1970s–80s fiscal crisis hit hard; large tracts went city-owned. Renewal accelerated in the late 1990s–2000s (the Upper Manhattan Empowerment Zone, Bill Clinton's office on 125th in 2001), with rezonings and new development reshaping the corridor since."
    ],
    notableStory: "The Apollo Theater on 125th launched Ella Fitzgerald (Amateur Night, 1934), Billie Holiday, James Brown, and countless others. Nearby Strivers' Row (the 1890s King Model Houses on West 138th–139th) was home to W.C. Handy and Eubie Blake, and remains one of the finest intact row-house ensembles in the city.",
    growth: "Harlem's demographic turnover in the early 20th century was dramatic — from majority-white to the nation's pre-eminent Black neighborhood within about two decades — and it has been re-diversifying and re-pricing since the 2000s.",
    ppsfHistory: [ {year:2005,ppsf:450},{year:2010,ppsf:500},{year:2015,ppsf:700},{year:2020,ppsf:850},{year:2025,ppsf:950} ]
  },
  {
    slug: "midtown", label: "Midtown", borough: "Manhattan",
    zips: ["10018","10019","10020","10036","10022","10017","10001","10016"], defaultMode: "multifamily",
    keywords: ["midtown","garment district","times square","midtown east","midtown south","nomad","hudson yards","10019","10018"],
    established: "Developed as the city marched uptown in the late 1800s; cemented as the commercial core after Grand Central opened in 1913.",
    tagline: "Gilded-Age mansions → the densest business district on earth → office-to-residential conversion frontier.",
    history: [
      "Midtown filled in as Manhattan's population pushed north after the Civil War — first mansions and rowhouses, then theaters and commerce. Grand Central Terminal (1913) and the surrounding Terminal City development made it the commercial heart of the city.",
      "The 1920s–30s skyscraper race gave it the Chrysler Building (1930), the Empire State Building (1931), and later Rockefeller Center. The Garment District clothed America; Times Square became the entertainment crossroads.",
      "Today Midtown is the densest office district in the country, and — as remote work softened older Class B/C office — the leading frontier for office-to-residential conversion (467-m and the City of Yes), making it newly relevant for multifamily repositioning."
    ],
    notableStory: "When the Empire State Building opened in 1931 it was so far ahead of demand it was nicknamed the 'Empty State Building,' surviving its early years partly on ticket sales to the observation deck — and on King Kong's 1933 climb, which made it a global icon.",
    growth: "Residential population is rising again for the first time in generations as offices convert to apartments — a structural shift, not a cyclical one.",
    ppsfHistory: [ {year:2005,ppsf:950},{year:2010,ppsf:1100},{year:2015,ppsf:1500},{year:2020,ppsf:1650},{year:2025,ppsf:1700} ]
  },
  {
    slug: "williamsburg", label: "Williamsburg", borough: "Brooklyn",
    zips: ["11211","11249","11206","11222"], defaultMode: "multifamily",
    keywords: ["williamsburg","greenpoint","north brooklyn","domino","11211","11249"],
    established: "Laid out 1810s; an independent City of Williamsburgh before annexation to Brooklyn in 1855.",
    tagline: "Industrial waterfront and immigrant enclave → artist colony → luxury waterfront skyline.",
    history: [
      "Williamsburg was its own city before joining Brooklyn in 1855. The Williamsburg Bridge (1903) opened it to a wave of immigrants escaping the Lower East Side — Jewish, Italian, and later Puerto Rican and Dominican communities — alongside a dense industrial waterfront led by the Domino Sugar refinery.",
      "Industry declined late 20th century; cheap loft space drew artists and musicians from Manhattan in the 1990s, making Williamsburg the global byword for the 2000s 'hipster' scene.",
      "The 2005 Greenpoint–Williamsburg waterfront rezoning unleashed a wall of luxury towers along the East River; the Domino refinery itself became a landmarked mixed-use megaproject. Today it spans Hasidic South Williamsburg, the luxury waterfront, and the bar-and-boutique core."
    ],
    notableStory: "The Domino Sugar Refinery — once the largest sugar refinery in the world, refining more than half the sugar in the U.S. — sat derelict for years, hosted Kara Walker's monumental 2014 sugar 'Subtlety' sphinx, and has been reborn as a landmarked office-and-residential complex with a public park.",
    growth: "The waterfront went from active industry to tens of thousands of new residents post-2005 rezoning — one of Brooklyn's sharpest density and price re-ratings.",
    ppsfHistory: [ {year:2005,ppsf:450},{year:2010,ppsf:600},{year:2015,ppsf:900},{year:2020,ppsf:1100},{year:2025,ppsf:1250} ]
  },
  {
    slug: "crown-heights", label: "Crown Heights / Atlantic Ave", borough: "Brooklyn",
    zips: ["11213","11216","11225","11233","11238","11201","11217","11212","11207"], defaultMode: "development",
    keywords: ["crown heights","atlantic ave","atlantic avenue","bed-stuy","bedford stuyvesant","eastern parkway","aamup","11213","11238"],
    established: "Developed along Eastern Parkway (Olmsted & Vaux, 1870s) and built out as grand apartment houses in the early 1900s.",
    tagline: "Olmsted's grand boulevard and elegant apartment houses → a development corridor reborn by the 2025 Atlantic Avenue rezoning.",
    history: [
      "Crown Heights rose around Eastern Parkway — the world's first 'parkway,' designed by Frederick Law Olmsted and Calvert Vaux (creators of Central and Prospect Parks) in the 1870s. Grand limestone and brick apartment houses filled the blocks in the early 1900s.",
      "The 20th century brought a large Jewish community — the Chabad-Lubavitch movement made its world headquarters at 770 Eastern Parkway — alongside one of the largest Caribbean-American communities in the U.S., celebrated each Labor Day at the West Indian Day Parade.",
      "The Atlantic Avenue corridor running along the northern edge stayed low-rise: auto shops, gas stations, single-story warehouses, and surface parking. The Atlantic Avenue Mixed-Use Plan (AAMUP), approved May 28, 2025, upzoned that corridor — the earliest of the city's active rezonings — setting up a development cycle comparable to Gowanus."
    ],
    notableStory: "Eastern Parkway is itself the headline: the first roadway in the world ever called a 'parkway,' and the route of the West Indian American Day Carnival, the largest parade in North America, drawing well over a million people each year. One block north, the Atlantic corridor's gas stations and garages sit on land whose as-of-right value tripled overnight in 2025.",
    growth: "Gowanus offers the template: post-rezoning land there ran from roughly $40/BSF to $200–$350/BSF within a couple of years. Atlantic Avenue's owners are at the front of that curve now.",
    ppsfHistory: [ {year:2005,ppsf:300},{year:2010,ppsf:350},{year:2015,ppsf:550},{year:2020,ppsf:750},{year:2025,ppsf:900} ]
  }
];

export const TERRITORIES_QUICK = [
  { slug:"ues", label:"Upper East Side", borough:"Manhattan", zips:["10021","10028","10065","10075","10128"], defaultMode:"multifamily", keywords:["upper east side","ues","yorkville","carnegie hill"] },
  { slug:"uws", label:"Upper West Side", borough:"Manhattan", zips:["10023","10024","10025","10069"], defaultMode:"multifamily", keywords:["upper west side","uws","lincoln square","manhattan valley"] },
  { slug:"east-village", label:"East Village / LES", borough:"Manhattan", zips:["10009","10003","10002"], defaultMode:"multifamily", keywords:["east village","les","lower east side","alphabet city"] },
  { slug:"soho-tribeca", label:"SoHo / Tribeca", borough:"Manhattan", zips:["10013","10012","10007"], defaultMode:"multifamily", keywords:["soho","tribeca","noho","hudson square"] },
  { slug:"fidi", label:"Financial District", borough:"Manhattan", zips:["10004","10005","10006","10038","10280"], defaultMode:"multifamily", keywords:["fidi","financial district","lower manhattan","battery park city"] },
  { slug:"flatiron", label:"Flatiron / NoMad", borough:"Manhattan", zips:["10010","10016"], defaultMode:"multifamily", keywords:["flatiron","nomad","gramercy","murray hill"] },
  { slug:"astoria", label:"Astoria", borough:"Queens", zips:["11102","11103","11105","11106"], defaultMode:"multifamily", keywords:["astoria","ditmars","steinway"] },
  { slug:"downtown-bk", label:"Downtown Brooklyn", borough:"Brooklyn", zips:["11201","11217","11205"], defaultMode:"development", keywords:["downtown brooklyn","fort greene","boerum hill"] },
  { slug:"bushwick", label:"Bushwick", borough:"Brooklyn", zips:["11221","11237","11206"], defaultMode:"development", keywords:["bushwick"] },
  { slug:"bed-stuy", label:"Bedford-Stuyvesant", borough:"Brooklyn", zips:["11216","11221","11233","11238"], defaultMode:"multifamily", keywords:["bed-stuy","bedford stuyvesant","bedstuy"] },
  { slug:"mott-haven", label:"Mott Haven / South Bronx", borough:"Bronx", zips:["10451","10454","10455"], defaultMode:"development", keywords:["mott haven","south bronx","port morris"] },
  { slug:"west-village", label:"West Village / Greenwich Village", borough:"Manhattan", zips:["10014","10011","10012"], defaultMode:"multifamily", keywords:["west village","greenwich village","far west village"] },
  { slug:"hells-kitchen", label:"Hell's Kitchen", borough:"Manhattan", zips:["10019","10036","10018"], defaultMode:"multifamily", keywords:["hell's kitchen","hells kitchen","clinton","midtown west"] },
  { slug:"murray-hill", label:"Murray Hill / Kips Bay", borough:"Manhattan", zips:["10016","10010"], defaultMode:"multifamily", keywords:["murray hill","kips bay","rose hill"] },
  { slug:"morningside", label:"Morningside Heights", borough:"Manhattan", zips:["10027","10025"], defaultMode:"multifamily", keywords:["morningside heights","columbia","manhattanville"] },
  { slug:"washington-heights", label:"Washington Heights / Inwood", borough:"Manhattan", zips:["10032","10033","10040","10034"], defaultMode:"multifamily", keywords:["washington heights","inwood","hudson heights"] },
  { slug:"hamilton-heights", label:"Hamilton Heights / Sugar Hill", borough:"Manhattan", zips:["10031","10039"], defaultMode:"multifamily", keywords:["hamilton heights","sugar hill","west harlem"] },
  { slug:"east-harlem", label:"East Harlem", borough:"Manhattan", zips:["10029","10035"], defaultMode:"development", keywords:["east harlem","spanish harlem","el barrio"] },
  { slug:"chinatown", label:"Chinatown / Two Bridges", borough:"Manhattan", zips:["10013","10002","10038"], defaultMode:"multifamily", keywords:["chinatown","two bridges","little italy"] },
  { slug:"greenpoint", label:"Greenpoint", borough:"Brooklyn", zips:["11222"], defaultMode:"development", keywords:["greenpoint"] },
  { slug:"park-slope", label:"Park Slope", borough:"Brooklyn", zips:["11215","11217"], defaultMode:"multifamily", keywords:["park slope"] },
  { slug:"gowanus", label:"Gowanus", borough:"Brooklyn", zips:["11231","11215"], defaultMode:"development", keywords:["gowanus"] },
  { slug:"prospect-heights", label:"Prospect Heights", borough:"Brooklyn", zips:["11238"], defaultMode:"multifamily", keywords:["prospect heights"] },
  { slug:"clinton-hill", label:"Clinton Hill / Fort Greene", borough:"Brooklyn", zips:["11205","11238"], defaultMode:"multifamily", keywords:["clinton hill","fort greene"] },
  { slug:"carroll-gardens", label:"Carroll Gardens / Cobble Hill", borough:"Brooklyn", zips:["11231","11201"], defaultMode:"multifamily", keywords:["carroll gardens","cobble hill","boerum hill","red hook"] },
  { slug:"sunset-park", label:"Sunset Park", borough:"Brooklyn", zips:["11220","11232"], defaultMode:"development", keywords:["sunset park","industry city"] },
  { slug:"bay-ridge", label:"Bay Ridge", borough:"Brooklyn", zips:["11209"], defaultMode:"multifamily", keywords:["bay ridge","dyker heights"] },
  { slug:"flatbush", label:"Flatbush / PLG", borough:"Brooklyn", zips:["11225","11226"], defaultMode:"multifamily", keywords:["flatbush","prospect lefferts gardens","plg","ditmas park"] },
  { slug:"east-ny", label:"East New York", borough:"Brooklyn", zips:["11207","11208"], defaultMode:"development", keywords:["east new york","eny","cypress hills"] },
  { slug:"bensonhurst", label:"Bensonhurst", borough:"Brooklyn", zips:["11214","11204"], defaultMode:"multifamily", keywords:["bensonhurst"] },
  { slug:"sunnyside", label:"Sunnyside / Woodside", borough:"Queens", zips:["11104","11377"], defaultMode:"multifamily", keywords:["sunnyside","woodside"] },
  { slug:"jackson-heights", label:"Jackson Heights / Elmhurst", borough:"Queens", zips:["11372","11373"], defaultMode:"multifamily", keywords:["jackson heights","elmhurst","corona"] },
  { slug:"flushing", label:"Flushing", borough:"Queens", zips:["11354","11355"], defaultMode:"development", keywords:["flushing","downtown flushing"] },
  { slug:"jamaica", label:"Jamaica", borough:"Queens", zips:["11432","11433","11435"], defaultMode:"development", keywords:["jamaica","downtown jamaica"] },
  { slug:"forest-hills", label:"Forest Hills / Rego Park", borough:"Queens", zips:["11375","11374"], defaultMode:"multifamily", keywords:["forest hills","rego park"] },
  { slug:"ridgewood", label:"Ridgewood", borough:"Queens", zips:["11385"], defaultMode:"multifamily", keywords:["ridgewood","glendale"] },
  { slug:"whitestone", label:"Whitestone / Malba", borough:"Queens", zips:["11357"], defaultMode:"multifamily", keywords:["whitestone","malba","11357"] },
  { slug:"beechhurst", label:"Beechhurst / Bay Terrace", borough:"Queens", zips:["11357","11360"], defaultMode:"multifamily", keywords:["beechhurst","bay terrace","cryder point","clearview","11360"] },
  { slug:"college-point", label:"College Point", borough:"Queens", zips:["11356"], defaultMode:"development", keywords:["college point","11356"] },
  { slug:"bayside", label:"Bayside / Oakland Gardens", borough:"Queens", zips:["11361","11364"], defaultMode:"multifamily", keywords:["bayside","oakland gardens","bell boulevard","11361"] },
  { slug:"auburndale", label:"Auburndale / Broadway-Flushing", borough:"Queens", zips:["11358"], defaultMode:"multifamily", keywords:["auburndale","broadway flushing","11358"] },
  { slug:"douglaston", label:"Douglaston / Little Neck", borough:"Queens", zips:["11362","11363"], defaultMode:"multifamily", keywords:["douglaston","little neck","11362"] },
  { slug:"fresh-meadows", label:"Fresh Meadows / Hillcrest", borough:"Queens", zips:["11365","11366"], defaultMode:"multifamily", keywords:["fresh meadows","hillcrest","utopia"] },
  { slug:"corona", label:"Corona / East Elmhurst", borough:"Queens", zips:["11368","11369","11370"], defaultMode:"multifamily", keywords:["corona","east elmhurst","lefrak city"] },
  { slug:"kew-gardens", label:"Kew Gardens / Briarwood", borough:"Queens", zips:["11415","11418","11435"], defaultMode:"multifamily", keywords:["kew gardens","briarwood","richmond hill"] },
  { slug:"maspeth", label:"Maspeth / Middle Village", borough:"Queens", zips:["11378","11379"], defaultMode:"multifamily", keywords:["maspeth","middle village"] },
  { slug:"woodhaven", label:"Woodhaven / Ozone Park", borough:"Queens", zips:["11421","11416","11417"], defaultMode:"multifamily", keywords:["woodhaven","ozone park"] },
  { slug:"howard-beach", label:"Howard Beach", borough:"Queens", zips:["11414"], defaultMode:"multifamily", keywords:["howard beach","lindenwood"] },
  { slug:"queens-village", label:"Queens Village / Bellerose", borough:"Queens", zips:["11427","11428","11429"], defaultMode:"multifamily", keywords:["queens village","bellerose","glen oaks","hollis"] },
  { slug:"se-queens", label:"St. Albans / Springfield Gardens", borough:"Queens", zips:["11412","11413","11434","11436"], defaultMode:"multifamily", keywords:["st albans","springfield gardens","rosedale","laurelton","cambria heights"] },
  { slug:"rockaway", label:"Rockaway Peninsula", borough:"Queens", zips:["11691","11692","11693","11694"], defaultMode:"development", keywords:["rockaway","far rockaway","rockaway beach","arverne","belle harbor"] },
  { slug:"concourse", label:"Concourse / Highbridge", borough:"Bronx", zips:["10452","10456"], defaultMode:"development", keywords:["concourse","grand concourse","highbridge"] },
  { slug:"fordham", label:"Fordham / Belmont", borough:"Bronx", zips:["10458","10468"], defaultMode:"multifamily", keywords:["fordham","belmont","arthur avenue"] },
  { slug:"riverdale", label:"Riverdale / Kingsbridge", borough:"Bronx", zips:["10463","10471"], defaultMode:"multifamily", keywords:["riverdale","kingsbridge","spuyten duyvil"] },
  { slug:"st-george", label:"St. George / North Shore", borough:"Staten Island", zips:["10301","10304","10310"], defaultMode:"development", keywords:["st george","stapleton","north shore","staten island","tompkinsville"] }
];

export const TERRITORIES = [...TERRITORIES_AUTHORED, ...TERRITORIES_QUICK];

const norm = (s) => s.trim().toLowerCase();

export function resolveTerritory(q) {
  const t = norm(String(q || ""));
  if (!t) return null;
  for (const n of TERRITORIES) {
    if (n.slug === t || norm(n.label) === t || n.keywords.some((k) => k === t)) return n;
  }
  for (const n of TERRITORIES) {
    if (norm(n.label).includes(t) || n.keywords.some((k) => k.includes(t) || t.includes(k))) return n;
  }
  const zip = (t.match(/\b\d{5}\b/) || [])[0];
  if (zip) {
    const n = TERRITORIES.find((x) => x.zips.includes(zip));
    if (n) return n;
  }
  return null;
}

export function territoryBySlug(slug) {
  return TERRITORIES.find((t) => t.slug === slug) || null;
}
