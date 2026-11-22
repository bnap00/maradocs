import { Bot, KeyRound, Puzzle, Rocket, Terminal, Webhook } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "../components/Layout";
import { ButtonLink, CodeBlock, CopyField } from "../components/ui";
import { useApp } from "../lib/app";
import { useDocumentTitle } from "../lib/useDocumentTitle";

function Step({ n, icon, title, children }: { n: number; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="step">
      <div className="step-marker" aria-hidden>
        <span className="step-num">{n}</span>
      </div>
      <div className="step-body">
        <h2 className="step-title">
          <span className="step-icon">{icon}</span>
          {title}
        </h2>
        <div className="stack-3">{children}</div>
      </div>
    </li>
  );
}

export function ConnectPage() {
  useDocumentTitle("Connect");
  const { serverUrl, user } = useApp();

  const agentPrompt = `When I ask you to create a report, dashboard or other document, build it as a static HTML site (index.html plus assets) and publish it with the MaraDocs skill / CLI, then reply with the URL it prints. Use a short, descriptive repo and doc slug (lowercase, hyphens). Republishing the same --repo/--doc creates a new version at the same URL.`;

  return (
    <>
      <PageHeader
        title="Connect an agent"
        description="Set up the CLI and skill once; agents and scripts can then publish reports to this deployment."
      />

      <div className="connect-layout">
        <ol className="steps">
          <Step n={1} icon={<Terminal size={16} aria-hidden />} title="Install the CLI">
            <p className="muted">Requires Node.js 22 or newer.</p>
            <CodeBlock code="npm install -g @maradocs/cli" label="Copy install command" />
          </Step>

          <Step n={2} icon={<KeyRound size={16} aria-hidden />} title="Sign in">
            <p className="muted">
              Bootstrap signs in with your MaraDocs account (it prompts for the password), mints a{" "}
              <strong>publish</strong>-scoped API key for it and saves the key to <code>~/.maradocs/config.json</code>.
            </p>
            <CodeBlock code={`maradocs auth bootstrap --server ${serverUrl} --email ${user.email}`} label="Copy bootstrap command" />
            <p className="muted small">
              Prefer not to type your password on that machine?{" "}
              <ButtonLink to="/keys" variant="ghost" size="sm">
                Create a key here
              </ButtonLink>{" "}
              and run the command below. It asks for the server URL and the key, and reads the key without echo so it
              stays out of your shell history.
            </p>
            <CodeBlock code="maradocs auth setup" label="Copy setup command" />
          </Step>

          <Step n={3} icon={<Puzzle size={16} aria-hidden />} title="Install the agent skill">
            <p className="muted">
              Works with Claude Code, OpenCode, OpenClaw, Hermes and other skills.sh-compatible agents. The skill reuses the
              CLI's saved credentials.
            </p>
            <CodeBlock
              code="npx skills add https://github.com/bnap00/maradocs --skill maradocs-publish"
              label="Copy skill install command"
            />
          </Step>

          <Step n={4} icon={<Bot size={16} aria-hidden />} title="Tell your agent when to use it">
            <p className="muted">Paste this into your agent's instructions or memory once:</p>
            <CodeBlock code={agentPrompt} label="Copy prompt" wrap />
          </Step>

          <Step n={5} icon={<Rocket size={16} aria-hidden />} title="Publish a test report">
            <CodeBlock
              code={`mkdir -p report && echo '<h1>Hello from MaraDocs</h1>' > report/index.html\nmaradocs publish ./report --repo demo --doc hello`}
              label="Copy test commands"
            />
            <p className="muted small">The repository is created on first publish. Republishing creates version 2 at the same URL.</p>
          </Step>
        </ol>

        <aside className="connect-aside">
          <section className="card" aria-labelledby="server-url-title">
            <h2 id="server-url-title" className="card-title">
              Server URL
            </h2>
            <p className="card-text">Use this everywhere a MaraDocs server is asked for.</p>
            <CopyField value={serverUrl} label="Server URL" />
          </section>

          <section className="card" aria-labelledby="ci-title">
            <h2 id="ci-title" className="card-title">
              CI &amp; containers
            </h2>
            <p className="card-text">Skip the config file and pass credentials through the environment:</p>
            <CodeBlock code={`MARADOCS_SERVER_URL=${serverUrl}\nMARADOCS_API_KEY=mdo_…`} label="Copy variables" />
          </section>

          <section className="card" aria-labelledby="rest-title">
            <h2 id="rest-title" className="card-title">
              <Webhook size={15} aria-hidden className="inline-icon" /> REST API
            </h2>
            <p className="card-text">
              Unlike the CLI, the REST API doesn't create repositories for you, and <code>POST</code> only creates a new
              document. Create the repository once:
            </p>
            <CodeBlock
              code={`curl -X POST ${serverUrl}/api/v1/repos \\\n  -H "Authorization: Bearer $MARADOCS_API_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"slug":"demo"}'`}
              label="Copy create-repository command"
            />
            <p className="card-text">Publish the first version of a document:</p>
            <CodeBlock
              code={`curl -X POST ${serverUrl}/api/v1/repos/demo/docs \\\n  -H "Authorization: Bearer $MARADOCS_API_KEY" \\\n  -F doc=hello -F file=@report.zip`}
              label="Copy first-publish command"
            />
            <p className="card-text">Publish later versions to the same URL:</p>
            <CodeBlock
              code={`curl -X PUT ${serverUrl}/api/v1/repos/demo/docs/hello \\\n  -H "Authorization: Bearer $MARADOCS_API_KEY" \\\n  -F file=@report.zip`}
              label="Copy new-version command"
            />
            <p className="card-text">
              Full reference:{" "}
              <a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer">
                OpenAPI spec
              </a>
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
