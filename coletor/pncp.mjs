// Coletor do PNCP (Portal Nacional de Contratações Públicas).
//
// Por lei, órgãos federais, estaduais e municipais publicam no PNCP os
// contratos que assinam. Quando um órgão contrata uma banca para REALIZAR um
// CONCURSO PÚBLICO, o concurso está a caminho: o app mostra "Banca contratada".
//
// Filtro rigoroso: entra só a contratação da banca organizadora de concurso
// público. Ficam de fora: processo seletivo (simplificado ou não), vestibular,
// residência, estágio, e serviços acessórios (gráfica, exames médicos ou
// toxicológicos, treinamento, alimentação, locação etc.).
//
// Uso: node coletor/pncp.mjs  (Node 20+, sem dependências). Lê e atualiza concursos.json.

import { readFile, writeFile } from "node:fs/promises";

const ARQUIVO = new URL("../concursos.json", import.meta.url);
const UA = "LumenPlanRadar/1.0 (+https://github.com/WSkywalker/lumen-radar-dados)";
const MUNICIPIOS_URL = "https://study-zen-planner-53.lovable.app/municipios.json";
const DIAS = 2; // janela de publicação (o coletor roda 2x/dia; sobra margem)
const MAX_PAGINAS = 80;
const PAUSA_MS = 800;
const VALIDADE_DIAS = 240; // depois disso, sem edital, o "banca contratada" sai da lista

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const norm = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

async function json(url) {
  for (let t = 1; t <= 4; t++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 204) return { data: [] };
      if (r.ok) return await r.json();
      if (r.status === 400 || r.status === 404) return null;
    } catch {
      /* conexão caiu: tenta de novo */
    }
    await sleep(2500 * t);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* filtro                                                              */
/* ------------------------------------------------------------------ */

// a banca é contratada para realizar/organizar o concurso
const OBJETO_CONCURSO =
  /(realizacao|organizacao|execucao|planejamento|operacionalizacao|elaboracao e aplicacao|prestacao de servicos? (tecnicos? )?(especializados? )?(para|de|na|visando)( a)? (realizacao|organizacao|execucao|planejamento))[^.;]{0,140}concurso(s)? publico/;
// serviços que só acompanham um concurso (não indicam um concurso novo)
const ACESSORIO =
  /(impress|grafic|reprograf|toxicolog|exames? (medic|admissiona|psicol|laborator)|avaliacao (medica|psicologica)|teste de aptidao|treinamento|curso de formacao|capacitacao|aliment|lanche|refeic|coffee|locacao|aluguel|transporte|hospedagem|passage|seguranca (do|dos|patrimonial)|vigilanc|limpeza|uniforme|fardamento|material|publicacao (em|no) (jornal|diario)|divulgacao|assessoria juridica|advocac|pericia|sistema (de|para) gestao|software|licenca de uso)/;
const NAO_CONCURSO =
  /(processo seletivo|selecao simplificada|vestibular|residencia|estagi|bolsa|credenciamento|chamamento|concurso (de|para) (projetos|fotografia|redacao|desenho|musica|beleza|arquitetura|ideias|literario|cultural|artistico)|premio|olimpiada)/;
const ADITIVO = /(termo aditivo|aditamento|apostilamento|prorrogacao de (prazo|vigencia)|reajuste|rescis)/;

function ehBancaDeConcurso(objeto, tipo) {
  const o = norm(objeto);
  if (!OBJETO_CONCURSO.test(o)) return false;
  if (ACESSORIO.test(o) || NAO_CONCURSO.test(o) || ADITIVO.test(o)) return false;
  if (ADITIVO.test(norm(tipo))) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* extração                                                            */
/* ------------------------------------------------------------------ */

function cargos(objeto) {
  const t = String(objeto).replace(/\s+/g, " ");
  const m =
    t.match(/provimento d[eoa]s? (?:\d+ \([^)]*\) )?(?:vagas? )?(?:(?:para|nos?|de) )?(?:(?:os|o) )?cargos? (?:efetivos? )?(?:d[eoa]s? )?([^.;]{3,120})/i) ??
    t.match(/para (?:os|o) cargos? d[eoa]s? ([^.;]{3,120})/i);
  const generico = "Cargos a definir (banca contratada)";
  if (!m) return generico;
  let c = m[1]
    .replace(/^(p[úu]blicos? )?(efetivos? )?(d[eoa]s? )?/i, "")
    .replace(/\s+(do|da|no|na|para o|para a) (quadro|municipio|munic[íi]pio|prefeitura|camara|c[âa]mara|administra[çc][ãa]o)\b.*$/i, "")
    .replace(/,?\s*(e|bem como)?\s*(a |à )?forma[çc][ãa]o de cadastro.*$/i, "")
    .trim();
  const n = norm(c);
  if (c.length < 4 || /^(e|no|na|nos|nas|de|do|da|para)\b/.test(n) || /cadastro de reserva|quadro de pessoal|conforme|edital|termo de referencia/.test(n)) return generico;
  return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
}

/** "MUNICIPIO DE BATAGUASSU" -> "Prefeitura de Bataguassu"; preposições em minúsculas. */
function nomeOrgao(razao, cidade) {
  let t = String(razao ?? "Órgão público").replace(/\s+/g, " ").trim().replace(/\s*-\s*[A-Za-z]{2}$/, "");
  const n = norm(t);
  if (cidade && /^(municipio|prefeitura)( municipal)? d[eo]/.test(n)) return `Prefeitura de ${cidade}`;
  if (cidade && /^camara (municipal|de vereadores)/.test(n)) return `Câmara Municipal de ${cidade}`;
  t = t.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  t = t.replace(/\b(De|Do|Da|Dos|Das|E|Em)\b/g, (w) => w.toLowerCase());
  return t.replace(/^Municipio de /, "Prefeitura de ").replace(/^Município de /, "Prefeitura de ");
}

const AREAS = [
  ["policial", /policia|policial|penal|penitenciar|seguranca publica|guarda (civil )?municipal|agente de transito|perito|detran/],
  ["militar", /bombeiro|militar|exercito|marinha|aeronautica/],
  ["previdenciaria", /previdencia|instituto de previdencia|\bipm\b|\binss\b/],
  ["fiscal", /fazenda|tribut|fiscal|auditor|receita|controladoria|tribunal de contas/],
  ["tribunais", /tribunal|justica|ministerio publico|defensoria|procuradoria/],
  ["diplomatica", /relacoes exteriores|itamaraty|diplomat/],
];
function area(texto) {
  const t = norm(texto);
  return AREAS.find(([, re]) => re.test(t))?.[0] ?? "administrativa";
}

const ESFERA = { F: "federal", E: "estadual", M: "municipal", D: "estadual" };

let MUNIS = [];
function lugar(unidade, esfera) {
  const uf = unidade?.ufSigla ?? null;
  if (esfera !== "municipal") return { uf, cidade: null, latitude: null, longitude: null };
  const nome = unidade?.municipioNome ?? null;
  const m = MUNIS.find((x) => x[1] === uf && norm(x[0]) === norm(nome));
  return { uf, cidade: m ? m[0] : nome, latitude: m ? m[2] : null, longitude: m ? m[3] : null };
}

/** Nome curto da banca a partir da razão social. */
function banca(razao) {
  const r = norm(razao);
  const conhecidas = [
    ["Cebraspe", /cebraspe|centro brasileiro de pesquisa em avaliacao/], ["FGV", /getulio vargas/],
    ["FCC", /carlos chagas/], ["Vunesp", /vunesp/], ["Cesgranrio", /cesgranrio/], ["IBFC", /ibfc|instituto brasileiro de formacao e capacitacao/],
    ["Idecan", /idecan/], ["Quadrix", /quadrix/], ["Consulplan", /consulplan/], ["Instituto AOCP", /aocp/],
    ["Fundatec", /fundatec/], ["Selecon", /selecon/], ["IADES", /iades/], ["Fundep", /fundep/], ["IBADE", /ibade/],
    ["Instituto Access", /access/], ["Avança SP", /avanca/], ["IBAM", /\bibam\b|instituto brasileiro de administracao municipal/],
    ["Instituto Consulplan", /consulplan/], ["Legalle", /legalle/], ["Objetiva", /objetiva concursos/], ["FAFIPA", /fafipa/],
  ];
  const k = conhecidas.find(([, re]) => re.test(r));
  if (k) return k[0];
  return String(razao ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || null;
}

/* ------------------------------------------------------------------ */
/* execução                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  const base = JSON.parse(await readFile(ARQUIVO, "utf8"));
  const porId = new Map(base.itens.map((i) => [i.id, i]));
  try {
    const r = await fetch(MUNICIPIOS_URL, { headers: { "User-Agent": UA } });
    if (r.ok) MUNIS = await r.json();
  } catch {
    MUNIS = [];
  }

  const fim = new Date();
  const ini = new Date(Date.now() - DIAS * 86_400_000);
  let paginas = 0, lidos = 0, aceitos = 0, novos = 0;

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const j = await json(
      `https://pncp.gov.br/api/consulta/v1/contratos?dataInicial=${ymd(ini)}&dataFinal=${ymd(fim)}&pagina=${pagina}&tamanhoPagina=500`,
    );
    if (!j || !Array.isArray(j.data) || j.data.length === 0) break;
    paginas++;
    for (const c of j.data) {
      lidos++;
      const objeto = `${c.objetoContrato ?? ""} ${c.informacaoComplementar ?? ""}`;
      if (!ehBancaDeConcurso(objeto, c.tipoContrato?.nome ?? "")) continue;
      aceitos++;
      const id = `pncp:${c.numeroControlePNCP}`;
      if (porId.has(id)) {
        porId.get(id).visto_em = new Date().toISOString();
        continue;
      }
      const esfera = ESFERA[c.orgaoEntidade?.esferaId] ?? "municipal";
      const loc = lugar(c.unidadeOrgao, esfera);
      const orgaoNome = String(c.orgaoEntidade?.razaoSocial ?? c.unidadeOrgao?.nomeUnidade ?? "Órgão público")
        .replace(/\s+/g, " ")
        .trim();
      const [cnpj, , resto] = String(c.numeroControlePNCP).split("-");
      const [seq, ano] = String(resto ?? "").split("/");
      const link =
        cnpj && ano && seq
          ? `https://pncp.gov.br/app/contratos/${cnpj}/${ano}/${Number(seq)}`
          : "https://pncp.gov.br/app/contratos";
      porId.set(id, {
        id,
        fonte_chave: id,
        origem: "robo",
        orgao: nomeOrgao(orgaoNome, loc.cidade),
        cargo: cargos(c.objetoContrato ?? ""),
        area: area(`${orgaoNome} ${cargos(c.objetoContrato ?? "")}`),
        objeto: String(c.objetoContrato ?? "").replace(/\s+/g, " ").slice(0, 600),
        abrangencia: loc.cidade ? "municipal" : esfera,
        uf: loc.uf,
        cidade: loc.cidade,
        latitude: loc.latitude,
        longitude: loc.longitude,
        situacao: "banca_contratada",
        vagas: null,
        banca: banca(c.nomeRazaoSocialFornecedor),
        inscricoes_inicio: null,
        inscricoes_fim: null,
        prova_data: null,
        edital_url: null,
        fonte_url: link,
        observacoes: `Contrato com a banca publicado no PNCP em ${String(c.dataPublicacaoPncp ?? "").slice(0, 10)}. Objeto: ${String(c.objetoContrato ?? "").replace(/\s+/g, " ").slice(0, 300)}`,
        publicado_em: String(c.dataPublicacaoPncp ?? c.dataAssinatura ?? "").slice(0, 10) || null,
        verificado_em: new Date().toISOString(),
        visto_em: new Date().toISOString(),
      });
      novos++;
    }
    if (j.data.length < 500 || (j.totalPaginas && pagina >= j.totalPaginas)) break;
    await sleep(PAUSA_MS);
  }

  // revisa os itens do PNCP já salvos com as regras atuais
  for (const i of porId.values()) {
    if (!i.id.startsWith("pncp:")) continue;
    const obj = i.objeto ?? String(i.observacoes ?? "").split("Objeto: ")[1] ?? "";
    if (!obj) continue;
    i.objeto = obj;
    i.cargo = cargos(obj);
    i.orgao = nomeOrgao(i.orgao, i.cidade);
    i.area = area(`${i.orgao} ${i.cargo}`);
  }

  const limite = new Date(Date.now() - VALIDADE_DIAS * 86_400_000).toISOString().slice(0, 10);
  const itens = [...porId.values()]
    .filter((i) => !i.id.startsWith("pncp:") || !(i.publicado_em && i.publicado_em < limite))
    .sort((a, b) => String(b.publicado_em).localeCompare(String(a.publicado_em)));

  await writeFile(
    ARQUIVO,
    JSON.stringify({ ...base, gerado_em: new Date().toISOString(), total: itens.length, itens }, null, 1) + "\n",
  );
  console.log(`PNCP: páginas ${paginas}; contratos lidos ${lidos}; de banca de concurso ${aceitos}; novos ${novos}; total no arquivo ${itens.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
