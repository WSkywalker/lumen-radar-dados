// Limpeza de nomes vindos de cadastros (PNCP): acentos que faltam, UF no fim, cargo que é só o órgão.

const UFS = "AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO";

// palavras que os cadastros costumam trazer sem acento
const ACENTOS = {
  imoveis: "Imóveis", regiao: "Região", municipio: "Município", municipal: "Municipal", camara: "Câmara",
  servicos: "Serviços", servico: "Serviço", saude: "Saúde", educacao: "Educação", agua: "Água",
  publico: "Público", publica: "Pública", previdencia: "Previdência", tecnico: "Técnico", tecnica: "Técnica",
  farmacia: "Farmácia", economico: "Econômico", economia: "Economia", contabilidade: "Contabilidade",
  medicina: "Medicina", odontologia: "Odontologia", psicologia: "Psicologia", nutricao: "Nutrição",
  fisioterapia: "Fisioterapia", veterinaria: "Veterinária", educacao_fisica: "Educação Física",
  administracao: "Administração", assistencia: "Assistência", seguranca: "Segurança", transito: "Trânsito",
  consorcio: "Consórcio", intermunicipal: "Intermunicipal", autarquia: "Autarquia", fundacao: "Fundação",
  agencia: "Agência", reguladora: "Reguladora", saneamento: "Saneamento", esgoto: "Esgoto",
  eletrica: "Elétrica", energia: "Energia", corretores: "Corretores", tecnicos: "Técnicos",
  instituicao: "Instituição", juridico: "Jurídico", juridica: "Jurídica", logistica: "Logística",
  policia: "Polícia", ministerio: "Ministério", justica: "Justiça", conselho: "Conselho",
  quimica: "Química", biologia: "Biologia", estatistica: "Estatística", engenharia: "Engenharia",
  agronomia: "Agronomia", autonomo: "Autônomo", publicos: "Públicos", publicas: "Públicas",
  politicas: "Políticas", ciencia: "Ciência", instancia: "Instância", sao: "São", tres: "Três",
  parana: "Paraná", paraiba: "Paraíba", balneario: "Balneário", aguas: "Águas", municipios: "Municípios", arquitetura: "Arquitetura", biomedicina: "Biomedicina", enfermagem: "Enfermagem",
};

/** "Conselho Regional de Corretores de Imoveis 9 Regiao Ba" -> "Conselho Regional de Corretores de Imóveis da 9ª Região" */
export function limpaOrgao(nome) {
  let t = String(nome ?? "").replace(/\s+/g, " ").trim();
  // UF no fim, só como palavra separada ("… 9 Regiao Ba", "… - SE"); nunca dentro do nome (Janaúba)
  t = t.replace(new RegExp(`(?:\\s*[-–/]\\s*|\\s+)(${UFS})$`, "i"), (m, uf, off) => (off > 10 ? "" : m));
  t = t.replace(/\b([\p{L}]+)\b/gu, (w) => {
    const a = ACENTOS[w.toLowerCase()];
    if (!a) return w;
    return w === w.toLowerCase() ? a.toLowerCase() : a;
  });
  t = t.replace(/\b(\d{1,2})[ªºa°]?\s+Regi[ãa]o\b/gi, "$1ª Região");
  t = t.replace(/\bde (\d{1,2}ª Região)/, "da $1").replace(/(Imóveis|Medicina|Engenharia|Enfermagem|Farmácia|Odontologia|Psicologia|Contabilidade|Administração|Economia|Biologia|Nutrição|Fisioterapia) (\d{1,2}ª Região)/, "$1 da $2");
  return t.trim();
}

/** Cargo que na verdade é o nome do órgão ("Prefeitura municipal de rio real e á"): vira genérico. */
export function cargoValido(cargo) {
  const n = String(cargo ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  if (!n) return false;
  if (/^(prefeitura|municipio|camara|secretaria|governo|estado|fundo municipal|consorcio)\b/.test(n)) return false;
  if (/\s(e|de|do|da|a|o)\s*[a-z]?$/.test(n)) return false; // termina cortado: "… e á"
  return true;
}
