# Sovara for Pi

Give Pi your team’s knowledge. Sovara automatically retrieves relevant lessons and records your sessions for review.

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
   - **Title:** Python testing
   - **When to use:** When writing Python tests
   - **Content:** Use pytest and keep tests beside the code they cover.
5. Ask Pi to write a Python test. Open the recorded session in Sovara to see the lesson under **Lessons applied** on the model step.

## Using Sovara

Your sessions are recorded automatically. Relevant lessons are added to Pi’s context as you work.

- **`/sovara`** — Check your connection, project, and recording status.
- **`/reload`** — Reload after installation or changing your Sovara connection.
- **`pi update`** — Update installed Pi packages from your terminal.

Pi records to the server you signed in to with `sovara login`. Your project defaults to the folder where you start Pi. To choose another name, add `.pi/sovara.json`:

```json
{ "projectName": "my-project" }
```

Subagents that Pi starts are recorded as child traces of the turn that started them. Parent and subagent must use the same `@sovara/pi` version.

To uninstall:

```sh
pi remove npm:@sovara/pi
```

## Development

See [Development](https://github.com/SovaraLabs/sovara-pi#development).

## License

MIT.
