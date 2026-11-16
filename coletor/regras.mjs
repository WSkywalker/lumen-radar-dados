// Regras de leitura de texto de editais (compartilhadas entre coletores).

const ENT0 = { nbsp: " ", amp: "&", quot: '"', lt: "<", gt: ">", ordm: "º", ordf: "ª" };
const ACENTO = { acute: "\u0301", grave: "\u0300", circ: "\u0302", tilde: "\u0303", cedil: "\u0327", uml: "\u0308" };
const ENT = { ...ENT0, ndash: "–", mdash: "—", deg: "°", sect: "§", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", middot: "·" };
export function textoLimpo(h) {
  return String(h ?? "")
    .replace(/&([a-zA-Z])(acute|grave|circ|tilde|cedil|uml);/g, (_, l, k) => (l + ACENTO[k]).normalize("NFC"))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}
export const norm = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const MESES = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7,
  agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
export const iso = (d, m, y) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Todas as datas de um trecho, na ordem em que aparecem. */
export function datas(trecho) {
  const t = norm(trecho);
  const out = [];
  const re = /(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{1,2})(?:º|o)? de (janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?: de (\d{4}))?/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1]) out.push({ pos: m.index, data: iso(+m[1], +m[2], +m[3]), ano: true });
    else out.push({ pos: m.index, data: iso(+m[4], MESES[m[5]], m[6] ? +m[6] : 0), ano: !!m[6] });
  }
  // completa o ano que faltar com o da data seguinte (ex.: "de 3 de março a 2 de abril de 2027")
  for (let i = out.length - 1; i >= 0; i--) {
    if (!out[i].ano) {
      const prox = out.slice(i + 1).find((x) => x.ano);
      const y = prox ? prox.data.slice(0, 4) : String(new Date().getFullYear());
      out[i].data = y + out[i].data.slice(4);
      out[i].ano = true;
    }
  }
  return out.filter((x) => !/^0|-00-/.test(x.data));
}

export function periodoInscricoes(texto) {
  const t = norm(texto);
  const re = /inscri[cç](?:o|a)es?[^.]{0,220}?(?:periodo|entre|de|a partir)[^.]{0,200}/g;
  let m;
  while ((m = re.exec(t))) {
    const ds = datas(m[0]);
    if (ds.length >= 2 && ds[1].data >= ds[0].data) return [ds[0].data, ds[1].data];
  }
  return [null, null];
}

export function dataProva(texto) {
  const t = norm(texto);
  const re = /(prova|provas) (objetiva|objetivas|escrita|escritas)?[^.]{0,160}/g;
  let m;
  while ((m = re.exec(t))) {
    if (!/(sera|serao|realizad|aplicad|data provavel|previst)/.test(m[0])) continue;
    const d = datas(m[0])[0];
    if (d) return d.data;
  }
  return null;
}

export function vagas(texto) {
  const t = norm(texto);
  const nums = [...t.matchAll(/(\d{1,3}(?:\.\d{3})*|\d+)\s*(?:\([a-z\s-]+\)\s*)?vagas?\b/g)]
    .map((m) => Number(m[1].replace(/\./g, "")))
    .filter((n) => n > 0 && n < 100000);
  return nums.length ? Math.max(...nums) : null;
}

export const BANCAS = [
  ["Cebraspe", /cebraspe|cespe/], ["FGV", /fundacao getulio vargas|\bfgv\b/], ["FCC", /fundacao carlos chagas|\bfcc\b/],
  ["Vunesp", /vunesp/], ["Cesgranrio", /cesgranrio/], ["IBFC", /\bibfc\b/], ["Idecan", /idecan/],
  ["Quadrix", /quadrix/], ["Consulplan", /consulplan/], ["Instituto AOCP", /\baocp\b/], ["Fundatec", /fundatec/],
  ["Selecon", /selecon/], ["IADES", /\biades\b/], ["Cesgranrio", /cesgranrio/], ["Instituto Verbena", /verbena/],
  ["Comperve", /comperve/], ["Fundep", /fundep/], ["IBADE", /\bibade\b/], ["Avança SP", /avanca sp/],
];
export function banca(texto) {
  const t = norm(texto);
  return BANCAS.find(([, re]) => re.test(t))?.[0] ?? null;
}

export function cargo(texto) {
  const t = String(texto).replace(/\s+/g, " ");
  const m =
    t.match(/provimento d[eoa]s? (?:\d+ \([^)]*\) )?(?:vagas? )?(?:para |no |nos |de )?cargos? (?:efetivos? )?d[eoa]s? ([^.,;:]{3,90})/i) ??
    t.match(/para o cargo d[eoa] ([^.,;:]{3,90})/i) ??
    t.match(/carreira d[eoa] ([^.,;:]{3,90})/i);
  if (!m) return "Diversos cargos";
  return m[1]
    .replace(/\s+(processo|edital)\b.*$/i, "")
    .replace(/\s+(do|da|no|na)\s+quadro.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

export const UF_NOMES = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul",
  MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí",
  RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima",
  SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};
export function uf(texto) {
  const t = norm(texto);
  const nomes = Object.entries(UF_NOMES).sort((a, b) => b[1].length - a[1].length);
  for (const [sigla, nome] of nomes) {
    const k = norm(nome);
    if (new RegExp(`\\b(do|da|de|no|na|em) ${k}\\b`).test(t)) return sigla;
  }
  const m = String(texto).match(/[-/(]\s?([A-Z]{2})\b/);
  return m && UF_NOMES[m[1]] ? m[1] : null;
}

export const AREAS = [
  ["diplomatica", /diplomat|rio branco|itamaraty|relacoes exteriores|oficial de chancelaria/],
  ["militar", /exercito|marinha|aeronautica|comando da (marinha|aeronautica|exercito)|forcas armadas|ministerio da defesa/],
  ["policial", /policia|policial|penal|penitenciar|seguranca publica|perito criminal|agente de policia/],
  ["previdenciaria", /\binss\b|previdencia/],
  ["fiscal", /receita federal|fazenda|tribut|auditor|controladoria|tribunal de contas|banco central|\bcvm\b|tesouro/],
  ["tribunais", /tribunal|justica|ministerio publico|defensoria|advocacia-geral|procuradoria|\bagu\b/],
  ["outra", /universidade|instituto federal|professor|magisterio|docente|hospital universitario|ebserh|residencia/],
];
export function area(texto) {
  const t = norm(texto);
  return AREAS.find(([, re]) => re.test(t))?.[0] ?? "administrativa";
}

export const ABERTURA = /(torna (publica|publico)[^.]{0,80}abertura|abertura d[ae]s? inscric|abertura de concurso|estarao abertas as inscricoes|ficam abertas as inscricoes)/;
export const DESCARTA = /(resultado|homologa|prorroga|retifica|convoca|nomea|licitac|pregao|processo seletivo simplificado|professor substituto|professor visitante|mestrado|doutorado|residencia|monitoria|estagio|bolsista)/;

