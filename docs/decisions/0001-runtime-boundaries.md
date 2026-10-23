# ADR 0001: Runtime and Repository Boundaries

- Status: accepted implementation baseline
- Context: Lumin combined bot behavior, model integration, memory indexing and a static admin console in one process/repository.
- Decision: retain the bot's feature set; isolate validated runtime config, security policies, migration runner, and persistence boundaries; move the website into a separate repository; disable legacy RAG/cluster memory; keep the last-five-message context contract; use Redis only as an optional distributed rate-limit counter.
- Consequences: the separate console must configure its API base URL and allowed origin. The current in-process session store is single-instance only until a shared session store or sticky deployment strategy is implemented. Legacy vector data is not deleted automatically.
