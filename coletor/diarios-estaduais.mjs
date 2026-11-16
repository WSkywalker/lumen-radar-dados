// Coletor dos Diários Oficiais estaduais que usam o mesmo sistema de publicação
// (busca pública por página): AP, AM, ES, GO e MT. Esses diários também trazem
// atos de municípios do estado.
//
// Só entram EDITAIS DE ABERTURA DE CONCURSO PÚBLICO. Nomeações, convocações,
// resultados, homologações, retificações, processos seletivos e licitações ficam de fora.
//
// Uso: node coletor/diarios-estaduais.mjs  (Node 20+, sem dependências).

import { readFile, writeFile } from "node:fs/promises";
import { ABERTURA, area, banca, cargo, dataProva, norm, periodoInscricoes, textoLimpo, vagas } from "./regras.mjs";

const ARQUIVO = new URL("../concursos.json", import.meta.url);
const UA = "LumenPlanRadar/1.0 (+https://github.com/WSkywalker/lumen-radar-dados)";
const MUNICIPIOS_URL = "https://study-zen-planner-53.lovable.app/municipios.json";
const DIARIOS = [
  { uf: "ES", nome: "Diário Oficial do Espírito Santo", base: "https://ioes.dio.es.gov.br" },
  { uf: "AP", nome: "Diário Oficial do Amapá", base: "https://diofe.portal.ap.gov.br" },
  { uf: "AM", nome: "Diário Oficial do Amazonas", base: "https://diario.imprensaoficial.am.gov.br" },
  { uf: "GO", nome: "Diário Oficial de Goiás", base: "https://diariooficial.abc.go.gov.br" },
  { uf: "MT", nome: "Diário Oficial de Mato Grosso", base: "https://www.iomat.mt.gov.br" },
];
const BUSCAS = ['"abertura de inscrições"', '"torna pública a abertura"', '"edital de abertura"'];
const DIAS = Number(process.env.DIARIOS_DIAS ?? 3);
const MAX_PAGINAS = 8; // de 10 resultados cada
const PAUSA_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDia = (d) => d.toISOString().slice(0, 10);

async function json(url) {
  for (let t = 1; t <= 3; t++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {
      /* tenta de novo */
    }
    await sleep(2500 * t);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* recorte do ato dentro da página do diário                           */
/* ------------------------------------------------------------------ */

const NAO_ABERTURA =
  /(nomea|convoca|resultado|homolog|classifica|retifica|prorroga|torna sem efeito|exonera|posse|gabarito|recurso|deferi|aprovad|licitac|pregao|contrato|extrato|processo seletivo|selecao simplificada|credenciamento|chamamento|estagi|residencia|aditamento|cancelamento|anulacao|suspensao)/;

/** Recorta o ato que contém a abertura: do título ("EDITAL ...") até ~8 mil caracteres depois. */
function recortar(pagina) {
  const t = String(pagina);
  const n = norm(t);
  const m = n.match(/(torna publica a abertura|abertura de inscric|abertura do concurso|estarao abertas as inscric|ficam abertas as inscric)/);
  if (!m) return null;
  const pos = m.index ?? 0;
  // volta até o título do ato mais próximo
  const antes = n.slice(Math.max(0, pos - 2500), pos);
  const titulos = [...antes.matchAll(/(edital|aviso|portaria|decreto|resolucao)\b[^.]{0,80}/g)];
  const ini = titulos.length ? Math.max(0, pos - 2500) + (titulos[titulos.length - 1].index ?? 0) : Math.max(0, pos - 800);
  return t.slice(ini, ini + 8000);
}

const MESES_N = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
void MESES_N;

let MUNIS = [];
function achaCidade(nome, uf) {
  const k = norm(nome);
  return MUNIS.find((x) => x[1] === uf && norm(x[0]) === k) ?? null;
}

/** Órgão e cidade a partir do texto do ato. */
function orgaoDoAto(ato, uf) {
  const t = String(ato).replace(/\s+/g, " ");
  const mun = t.match(/(?:prefeitura municipal|munic[ií]pio|c[âa]mara municipal|prefeito municipal|prefeita municipal)\s+d[eoa]s?\s+([A-ZÀ-Úa-zà-ú' -]{3,40}?)(?=[\s,./-]*(?:ES|AP|AM|GO|MT|estado|\/|,|\.|-|torna|no uso|$))/i);
  if (mun) {
    const cidade = achaCidade(mun[1].trim(), uf);
    if (cidade) {
      const camara = /c[âa]mara municipal/i.test(mun[0]);
      return { orgao: `${camara ? "Câmara Municipal" : "Prefeitura"} de ${cidade[0]}`, cidade, abrangencia: "municipal" };
    }
  }
  const est = t.match(
    /(secretaria de estado d[aoe]s? [^,.;:()]{3,70}|pol[íi]cia (?:militar|civil|penal|cient[íi]fica) d[oe] [^,.;:()]{3,40}|corpo de bombeiros militar[^,.;:()]{0,40}|tribunal (?:de justi[çc]a|de contas|regional)[^,.;:()]{0,60}|minist[ée]rio p[úu]blico[^,.;:()]{0,40}|defensoria p[úu]blica[^,.;:()]{0,40}|assembleia legislativa[^,.;:()]{0,40}|procuradoria[- ]geral[^,.;:()]{0,40}|departamento estadual de tr[âa]nsito[^,.;:()]{0,30}|detran[^,.;:()]{0,30}|universidade (?:estadual|do estado)[^,.;:()]{0,60}|instituto [^,.;:()]{3,60})/i,
  );
  if (est) {
    const o = est[1].trim().replace(/\s+/g, " ");
    return { orgao: o.charAt(0).toUpperCase() + o.slice(1), cidade: null, abrangencia: "estadual" };
  }
  return { orgao: null, cidade: null, abrangencia: "estadual" };
}

async function main() {
  const base = JSON.parse(await readFile(ARQUIVO, "utf8"));
  const porId = new Map(base.itens.map((i) => [i.id, i]));
  try {
    const r = await fetch(MUNICIPIOS_URL, { headers: { "User-Agent": UA } });
    if (r.ok) MUNIS = await r.json();
  } catch {
    MUNIS = [];
  }
  const di = isoDia(new Date(Date.now() - DIAS * 86_400_000));
  const df = isoDia(new Date());
  const resumo = [];

  for (const d of DIARIOS) {
    let paginas = 0, aceitos = 0, novos = 0, erro = null;
    for (const termo of BUSCAS) {
      for (let p = 0; p < MAX_PAGINAS; p++) {
        const j = await json(`${d.base}/busca/busca/buscar/query/${p}/di:${di}/df:${df}/?q=${encodeURIComponent(termo)}`);
        await sleep(PAUSA_MS);
        if (!j) {
          erro = "sem resposta";
          break;
        }
        const hits = j?.hits?.hits ?? [];
        if (!hits.length) break;
        paginas++;
        for (const h of hits) {
          const src = h._source ?? {};
          const pagina = textoLimpo(src.conteudo ?? "");
          const ato = recortar(pagina);
          if (!ato) continue;
          const inicio = norm(ato.slice(0, 1500));
          if (!/concurso publico/.test(inicio) || !ABERTURA.test(norm(ato.slice(0, 4000)))) continue;
          if (NAO_ABERTURA.test(inicio.slice(0, 250))) continue;
          if (/processo seletivo/.test(inicio.slice(0, 600)) && !/concurso publico/.test(inicio.slice(0, 300))) continue;
          const o = orgaoDoAto(ato, d.uf);
          if (!o.orgao) continue; // sem órgão identificável: melhor não publicar
          aceitos++;
          const id = `${d.uf.toLowerCase()}:${src.diario_id}-${src.pagina}-${norm(o.orgao).slice(0, 30).replace(/\s+/g, "-")}`;
          if (porId.has(id)) {
            porId.get(id).visto_em = new Date().toISOString();
            continue;
          }
          const [insIni, insFim] = periodoInscricoes(ato);
          const prova = dataProva(ato);
          const hoje = df;
          let situacao = "edital_publicado";
          if (prova && prova < hoje) situacao = "encerrado";
          else if (insIni && hoje < insIni) situacao = "edital_publicado";
          else if (insFim && hoje > insFim) situacao = "andamento";
          else if (insIni || insFim) situacao = "aberto";
          const link = `${d.base}/portal/visualizacoes/pdf/${src.diario_id}/#e:${src.diario_id}/#p:${src.pagina}`;
          porId.set(id, {
            id,
            fonte_chave: id,
            origem: "robo",
            orgao: o.orgao,
            cargo: cargo(ato),
            area: area(`${o.orgao} ${ato.slice(0, 2500)}`),
            abrangencia: o.abrangencia,
            uf: d.uf,
            cidade: o.cidade?.[0] ?? null,
            latitude: o.cidade?.[2] ?? null,
            longitude: o.cidade?.[3] ?? null,
            situacao,
            vagas: vagas(ato),
            banca: banca(ato),
            inscricoes_inicio: insIni,
            inscricoes_fim: insFim,
            prova_data: prova,
            edital_url: link,
            fonte_url: link,
            observacoes: `${d.nome} de ${String(src.data ?? "").split("-").reverse().join("/")}, pág. ${src.pagina}.`,
            publicado_em: src.data ?? hoje,
            verificado_em: new Date().toISOString(),
            visto_em: new Date().toISOString(),
          });
          novos++;
        }
        if (hits.length < 10) break;
      }
    }
    resumo.push(`${d.uf}: páginas ${paginas}, editais ${aceitos}, novos ${novos}${erro ? `, ${erro}` : ""}`);
  }

  // situação pelas datas; tira o que já passou
  const hoje = isoDia(new Date());
  const limite = isoDia(new Date(Date.now() - 45 * 86_400_000));
  const velho = isoDia(new Date(Date.now() - 240 * 86_400_000));
  const nossos = (i) => /^(es|ap|am|go|mt):/.test(i.id);
  const itens = [...porId.values()]
    .map((i) => {
      if (!nossos(i)) return i;
      let s = "edital_publicado";
      if (i.prova_data && i.prova_data < hoje) s = "encerrado";
      else if (i.inscricoes_inicio && hoje < i.inscricoes_inicio) s = "edital_publicado";
      else if (i.inscricoes_fim && hoje > i.inscricoes_fim) s = "andamento";
      else if (i.inscricoes_inicio || i.inscricoes_fim) s = "aberto";
      return { ...i, situacao: s };
    })
    .filter((i) => !nossos(i) || !(i.prova_data && i.prova_data < limite))
    .filter((i) => !nossos(i) || !(!i.prova_data && String(i.publicado_em) < velho));

  await writeFile(
    ARQUIVO,
    JSON.stringify({ ...base, gerado_em: new Date().toISOString(), total: itens.length, itens }, null, 1) + "\n",
  );
  console.log(`Diários estaduais — ${resumo.join(" | ")}; total no arquivo ${itens.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
