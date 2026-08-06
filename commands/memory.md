---
description: Gestisci la memoria a lungo termine (leggi, ricordi, aggiornamenti, cancellazioni)
---

L'utente vuole gestire la propria memoria a lungo termine. Usa gli strumenti dedicati in base alla richiesta:

- Lettura/ricerca: usa `memory_read` con la query se presente; riporta un riepilogo conciso dei fatti rilevanti.
- Salvataggio (`remember <fatto>` o un fatto esplicito): usa `memory_write`; se l'utente menziona "questo progetto" o "questo repo", imposta `scope: "project"`.
- Correzione (`update <fatto>`): usa `memory_update` cercando prima con `memory_read` se non ha dato un id.
- Cancellazione (`forget <testo>`): usa `memory_forget` (con `id` se noto, altrimenti testo).
- Svuotamento (`clear`): usa `memory_clear`.

Lingua: rispondi nella stessa lingua dell'utente.
