// Shared vocabulary for the demo data engine. Field names and enum values match
// what the real platform's client expects (observed in its shipped bundle);
// the generated values themselves are synthetic.

export const ZIPS_MANHATTAN = ["10001","10002","10003","10004","10005","10006","10007","10009","10010","10011","10012","10013","10014","10016","10017","10018","10019","10020","10021","10022","10023","10024","10025","10026","10027","10028","10029","10030","10031","10032","10033","10034","10035","10036","10037","10038","10039","10040","10044","10065","10069","10075","10128","10280","10282"];
export const ZIPS_BROOKLYN = ["11201","11203","11204","11205","11206","11207","11208","11209","11210","11211","11212","11213","11214","11215","11216","11217","11218","11219","11220","11221","11222","11223","11224","11225","11226","11228","11229","11230","11231","11232","11233","11234","11235","11236","11237","11238","11239","11249","11251"];
export const ZIPS_QUEENS = ["11004","11101","11102","11103","11104","11105","11106","11109","11354","11355","11356","11357","11358","11359","11360","11361","11362","11363","11364","11365","11366","11367","11368","11369","11370","11372","11373","11374","11375","11377","11378","11379","11385","11411","11412","11413","11414","11415","11416","11417","11418","11419","11420","11421","11422","11423","11426","11427","11428","11429","11432","11433","11434","11435","11436","11691","11692","11693","11694","11697"];
export const ZIPS_BRONX = ["10451","10452","10454","10455","10456","10458","10463","10468","10471"];
export const ZIPS_SI = ["10301","10304","10310"];

// Rough centroid per ZIP for the synthetic universe. Good enough to place a
// deterministic grid of lots inside believable geography.
export const ZIP_CENTERS = {
  "10001":[40.7506,-73.9970],"10002":[40.7168,-73.9861],"10003":[40.7317,-73.9891],"10004":[40.7038,-74.0132],
  "10005":[40.7061,-74.0086],"10006":[40.7093,-74.0132],"10007":[40.7139,-74.0079],"10009":[40.7264,-73.9786],
  "10010":[40.7391,-73.9826],"10011":[40.7420,-74.0000],"10012":[40.7255,-73.9983],"10013":[40.7204,-74.0048],
  "10014":[40.7343,-74.0053],"10016":[40.7454,-73.9781],"10017":[40.7523,-73.9727],"10018":[40.7550,-73.9930],
  "10019":[40.7656,-73.9852],"10020":[40.7590,-73.9790],"10021":[40.7693,-73.9598],"10022":[40.7583,-73.9670],
  "10023":[40.7769,-73.9827],"10024":[40.7863,-73.9754],"10025":[40.7987,-73.9668],"10026":[40.8023,-73.9527],
  "10027":[40.8116,-73.9532],"10028":[40.7764,-73.9535],"10029":[40.7917,-73.9438],"10030":[40.8183,-73.9426],
  "10031":[40.8251,-73.9500],"10032":[40.8388,-73.9427],"10033":[40.8501,-73.9339],"10034":[40.8672,-73.9212],
  "10035":[40.8015,-73.9370],"10036":[40.7593,-73.9903],"10037":[40.8127,-73.9373],"10038":[40.7094,-74.0025],
  "10039":[40.8262,-73.9364],"10040":[40.8583,-73.9302],"10044":[40.7618,-73.9497],"10065":[40.7645,-73.9634],
  "10069":[40.7756,-73.9903],"10075":[40.7734,-73.9563],"10128":[40.7816,-73.9500],"10280":[40.7085,-74.0166],
  "10282":[40.7166,-74.0146],
  "11201":[40.6939,-73.9896],"11203":[40.6494,-73.9345],"11204":[40.6188,-73.9846],"11205":[40.6946,-73.9662],
  "11206":[40.7021,-73.9424],"11207":[40.6706,-73.8940],"11208":[40.6714,-73.8717],"11209":[40.6222,-74.0301],
  "11210":[40.6281,-73.9464],"11211":[40.7126,-73.9531],"11212":[40.6629,-73.9129],"11213":[40.6710,-73.9364],
  "11214":[40.5988,-73.9962],"11215":[40.6624,-73.9860],"11216":[40.6807,-73.9494],"11217":[40.6822,-73.9790],
  "11218":[40.6435,-73.9764],"11219":[40.6326,-73.9967],"11220":[40.6413,-74.0166],"11221":[40.6913,-73.9276],
  "11222":[40.7278,-73.9479],"11223":[40.5971,-73.9733],"11224":[40.5766,-73.9887],"11225":[40.6631,-73.9542],
  "11226":[40.6465,-73.9567],"11228":[40.6167,-74.0130],"11229":[40.6009,-73.9443],"11230":[40.6221,-73.9651],
  "11231":[40.6779,-74.0045],"11232":[40.6567,-74.0075],"11233":[40.6783,-73.9199],"11234":[40.6204,-73.9215],
  "11235":[40.5836,-73.9490],"11236":[40.6404,-73.9013],"11237":[40.7043,-73.9211],"11238":[40.6796,-73.9633],
  "11239":[40.6488,-73.8798],"11249":[40.7127,-73.9629],"11251":[40.7000,-73.9707],
  "11004":[40.7460,-73.7118],"11101":[40.7472,-73.9395],"11102":[40.7723,-73.9260],"11103":[40.7627,-73.9134],
  "11104":[40.7444,-73.9204],"11105":[40.7787,-73.9068],"11106":[40.7621,-73.9314],"11109":[40.7451,-73.9573],
  "11354":[40.7681,-73.8274],"11355":[40.7515,-73.8215],"11356":[40.7846,-73.8420],"11357":[40.7862,-73.8106],
  "11358":[40.7605,-73.7962],"11359":[40.7920,-73.7770],"11360":[40.7803,-73.7815],"11361":[40.7639,-73.7717],
  "11362":[40.7566,-73.7367],"11363":[40.7723,-73.7466],"11364":[40.7451,-73.7605],"11365":[40.7397,-73.7947],
  "11366":[40.7284,-73.7940],"11367":[40.7300,-73.8210],"11368":[40.7515,-73.8525],"11369":[40.7632,-73.8722],
  "11370":[40.7648,-73.8887],"11372":[40.7517,-73.8830],"11373":[40.7388,-73.8785],"11374":[40.7263,-73.8615],
  "11375":[40.7211,-73.8455],"11377":[40.7447,-73.9053],"11378":[40.7247,-73.9096],"11379":[40.7168,-73.8797],
  "11385":[40.7005,-73.8895],"11411":[40.6941,-73.7364],"11412":[40.6980,-73.7591],"11413":[40.6716,-73.7527],
  "11414":[40.6578,-73.8447],"11415":[40.7080,-73.8281],"11416":[40.6845,-73.8496],"11417":[40.6764,-73.8443],
  "11418":[40.7002,-73.8358],"11419":[40.6884,-73.8228],"11420":[40.6736,-73.8177],"11421":[40.6941,-73.8586],
  "11422":[40.6600,-73.7360],"11423":[40.7157,-73.7684],"11426":[40.7364,-73.7223],"11427":[40.7307,-73.7455],
  "11428":[40.7209,-73.7423],"11429":[40.7098,-73.7387],"11432":[40.7154,-73.7925],"11433":[40.6981,-73.7869],
  "11434":[40.6767,-73.7762],"11435":[40.7010,-73.8096],"11436":[40.6758,-73.7967],"11691":[40.6013,-73.7621],
  "11692":[40.5942,-73.7924],"11693":[40.5903,-73.8087],"11694":[40.5780,-73.8452],"11697":[40.5568,-73.9077],
  "10451":[40.8201,-73.9251],"10452":[40.8373,-73.9235],"10454":[40.8055,-73.9166],"10455":[40.8149,-73.9086],
  "10456":[40.8298,-73.9083],"10458":[40.8624,-73.8890],"10463":[40.8807,-73.9065],"10468":[40.8677,-73.9000],
  "10471":[40.9030,-73.9040],
  "10301":[40.6315,-74.0949],"10304":[40.6096,-74.0872],"10310":[40.6329,-74.1158]
};

export const BOROUGH_BY_ZIP = (() => {
  const m = {};
  for (const z of ZIPS_MANHATTAN) m[z] = "Manhattan";
  for (const z of ZIPS_BROOKLYN) m[z] = "Brooklyn";
  for (const z of ZIPS_QUEENS) m[z] = "Queens";
  for (const z of ZIPS_BRONX) m[z] = "Bronx";
  for (const z of ZIPS_SI) m[z] = "Staten Island";
  return m;
})();

export const BORO_CODE = { Manhattan: "1", Bronx: "2", Brooklyn: "3", Queens: "4", "Staten Island": "5" };
export const BORO_BY_CODE = { 1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island" };

export const STREETS = {
  Manhattan: ["Broadway","Seventh Avenue","Eighth Avenue","Lexington Avenue","Madison Avenue","Amsterdam Avenue","Columbus Avenue","West 25th Street","West 38th Street","East 86th Street","Greenwich Street","Lafayette Street","Varick Street","Pearl Street","Water Street","Fifth Avenue","Park Avenue South","Tenth Avenue","Hudson Street","Canal Street"],
  Brooklyn: ["Atlantic Avenue","Court Street","Flatbush Avenue","Fourth Avenue","Bedford Avenue","Metropolitan Avenue","Nostrand Avenue","Myrtle Avenue","Fulton Street","Smith Street","Wythe Avenue","Union Street","DeKalb Avenue","Greenpoint Avenue","Coney Island Avenue","Church Avenue","Driggs Avenue","Kent Avenue"],
  Queens: ["Vernon Boulevard","Jackson Avenue","Northern Boulevard","Steinway Street","Queens Boulevard","31st Street","44th Drive","Broadway","Roosevelt Avenue","Jamaica Avenue","Ditmars Boulevard","Skillman Avenue","Greenpoint Avenue","21st Street"],
  Bronx: ["Grand Concourse","Third Avenue","Willis Avenue","Bruckner Boulevard","Fordham Road","Jerome Avenue","Westchester Avenue"],
  "Staten Island": ["Bay Street","Victory Boulevard","Richmond Terrace","St Marks Place"]
};

export const OWNER_LASTS = ["COHEN","RODRIGUEZ","CHEN","WILLIAMS","PATEL","ROSSI","KAPLAN","NGUYEN","MURPHY","SANTOS","GOLDBERG","JOHNSON","KIM","HERNANDEZ","O'BRIEN","SCHWARTZ","DIAZ","LEVIN","BROWN","RUSSO"];
export const OWNER_FIRSTS = ["MICHAEL","MARIA","DAVID","SUSAN","JOSEPH","ANNA","ROBERT","LINDA","JAMES","KAREN","THOMAS","BARBARA","DANIEL","NANCY","PETER","CAROL"];
export const ENTITY_STEMS = ["RIVERSIDE","NORTHGATE","BORO LINE","HARBORVIEW","GREENPOINT","ATLAS","EMPIRE","CROWN","PARKSIDE","STERLING","MERIDIAN","CANAL","HUDSON","LIBERTY","GOTHAM","VANGUARD","SUMMIT","BLUESTONE","IRONWORKS","CADENCE"];
export const ENTITY_SUFFIXES = ["REALTY LLC","HOLDINGS LLC","EQUITIES LLC","PROPERTIES LLC","PARTNERS LP","REALTY CORP","MANAGEMENT LLC","CAPITAL LLC","VENTURES LLC","ASSOCIATES LLC"];
export const LENDERS = ["SIGNATURE LENDING GROUP","FIRST GOTHAM BANK","NY COMMUNITY CAPITAL","EMIGRANT FUNDING","HARBOR SAVINGS BANK","METRO BRIDGE LENDING","CANAL STREET CAPITAL","DIME COMMUNITY LENDING"];

export const ZONES_RES = ["R6","R6A","R6B","R7A","R7D","R7X","R8","R8A","R9A","R10"];
export const ZONES_COM = ["C1-4","C2-4","C4-4","C4-6A","C5-2","C6-2A","C6-4","C6-4M","C8-2"];
export const ZONES_MFG = ["M1-1","M1-2","M1-4","M1-5","M1-6","M2-1","M3-1","MX-3"];

export const MAX_FAR_BY_ZONE = {
  R6: 2.43, R6A: 3.0, R6B: 2.0, R7A: 4.0, R7D: 5.6, R7X: 5.0, R8: 6.02, R8A: 6.02, R9A: 7.52, R10: 10.0,
  "C1-4": 3.44, "C2-4": 3.44, "C4-4": 3.4, "C4-6A": 10.0, "C5-2": 10.0, "C6-2A": 6.02, "C6-4": 10.0,
  "C6-4M": 12.0, "C8-2": 2.0, "M1-1": 1.0, "M1-2": 2.0, "M1-4": 2.0, "M1-5": 5.0, "M1-6": 10.0,
  "M2-1": 2.0, "M3-1": 2.0, "MX-3": 4.8
};

// Building-class letters weighted toward a believable NYC mix.
export const BLDG_CLASS_POOL = [
  "A1","A4","B1","B3","C0","C1","C2","C3","C4","C5","C6","C7","D1","D3","D4","D6","D7",
  "E1","F1","G1","H3","K1","K2","K4","L1","M1","O2","O4","O5","O6","R2","R4","S3","S5","V0","V1","W1","Z0"
];

export const LAND_USE_BY_CLASS = (cls) => {
  const c = (cls || "").slice(0, 1);
  if (c === "A" || c === "B") return "01";
  if (c === "C") return "02";
  if (c === "D") return "03";
  if (c === "S") return "04";
  if (c === "O" || c === "K" || c === "H" || c === "R") return "05";
  if (c === "E" || c === "F" || c === "L" || c === "M") return "06";
  if (c === "T" || c === "U") return "07";
  if (c === "W" || c === "I" || c === "J" || c === "N" || c === "P" || c === "Q") return "08";
  if (c === "G") return "10";
  if (c === "V" || c === "Z") return "11";
  return "05";
};

export const POLICY_CATALYSTS = ["467-m Phase 1","485-x","Midtown South Mixed-Use Plan","City of Yes","MIH","Gowanus Rezoning","OneLIC","Atlantic Avenue Mixed-Use Plan"];
export const RISK_FLAGS = ["Floorplate depth on lower floors","Partial tenant occupancy","Landmark overlay","Flood zone exposure","Multiple recorded liens","Holdout parcel in assemblage","Rent-regulated units possible","Environmental from prior auto use"];
