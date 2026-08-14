# NOIAS — Backend

Node/Express + PostgreSQL, no mesmo padrão dos outros apps MEDBI.

## Deploy no Render

1. Cria um **PostgreSQL** no Render (free tier serve para começar).
2. Corre o `schema.sql` nessa base de dados (Render dá um botão "Connect" com a `psql` command, ou usa qualquer cliente PostgreSQL tipo TablePlus/DBeaver).
3. Cria um **Web Service** no Render, aponta para este repositório/pasta.
   - Build command: `npm install`
   - Start command: `npm start`
4. Em **Environment**, adiciona a variável `DATABASE_URL` com a "Internal Database URL" que o Render te dá para a base de dados criada no passo 1.
5. Depois do deploy, vais ter um URL tipo `https://noias-backend.onrender.com`.

## Testar

```
curl https://noias-backend.onrender.com/api/health
```

Deve responder `{"ok":true}`.

## Ligar ao frontend

No `index.html` do app, no topo do `<script>`, muda:

```js
const API_BASE = "https://noias-backend.onrender.com/api";
```

## Notas

- As imagens dos memes são guardadas como `dataURL` (base64) diretamente na coluna `imagem_data` — simples para já, mas cresce a base de dados rápido. Se o volume de publicações aumentar muito, o próximo passo é mover as imagens para um object storage (Cloudflare R2, S3, etc.) e guardar só o URL.
- As rotas `/api/admin/*` não têm autenticação nenhuma ainda — qualquer pessoa com o URL pode banir/restaurar memes. Antes de divulgar o app, isso precisa de proteção (ex: uma chave simples em header, no mesmo estilo do servidor de licenças MEDBI).
- `likes` e `reports` usam `device_id` (gerado no telemóvel) para evitar likes/denúncias duplicadas do mesmo aparelho — não é autenticação real, só uma trava simples.
