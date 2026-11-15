# Sovara for Pi

Sovara helps teams manage domain knowledge and put it to work in AI agents.
Capture business rules, expert guidance, and lessons from experience in a shared
knowledge base. Deliver relevant knowledge to agents as they work, review how
they use it, and improve it together.

Bring your team's domain knowledge into Pi and review agent sessions together with Sovara.

Requires Node.js 24.22.1 or newer.

## Getting started

1. [Install the Sovara CLI](https://docs.sovara-labs.com/get-started/installation) and sign in with `sovara login --url <your Sovara URL>`.
2. Install the Pi extension, then start Pi from your project folder:

   ```sh
   pi install npm:@sovara/pi
   pi
   ```

3. Send a message in Pi. In Sovara, open the project matching your folder name.
4. Under **Lessons**, create a lesson:
   - **Title:** Refund approval
   - **When to use:** When handling customer refund requests
   - **Content:** Refunds above CHF 500 require approval from the support team lead.

   Apply the lesson to production and [enable knowledge injection](https://docs.sovara-labs.com/sovaradb/auto-injection).

5. Ask Pi how to handle a CHF 750 refund request. Open the recorded session in Sovara to see the lesson under **Lessons applied** on the model step.

## Using Sovara

Your sessions are recorded automatically. Relevant lessons are added to Pi’s context as you work.

- **`/sovara`** — Check your connection, project, and recording status.
- **`/reload`** — Reload after installation or changing your Sovara connection.
- **`pi update`** — Update installed Pi packages from your terminal.

Pi records to the server you signed in to with `sovara login`. To use another server, set `SOVARA_SERVER_URL`. Your project defaults to the folder where you start Pi. To choose another name, add `.pi/sovara.json`:

```json
{ "projectName": "my-project" }
```

Subagents that Pi starts are recorded as child traces of the turn that started them. Parent and subagent must use the same `@sovara/pi` version.

To uninstall:

```sh
pi remove npm:@sovara/pi
```

## License

MIT.
