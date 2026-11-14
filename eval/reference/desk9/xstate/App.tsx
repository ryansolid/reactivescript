import { AppActor } from "./appMachine";
import IssuesPage from "./issues/IssuesPage";
import HelpPage from "./help/HelpPage";
import SettingsPage from "./settings/SettingsPage";

export default function App() {
  return (
    <AppActor.Provider>
      <Desk />
    </AppActor.Provider>
  );
}

function Desk() {
  const desk = AppActor.useActorRef();
  const openCount = AppActor.useSelector(s => s.context.openCount);
  const { issues, help, settings } = AppActor.useSelector(s => s.children);
  return (
    <div>
      <nav>
        <button type="button" data-testid="tab-issues" onClick={() => desk.send({ type: "tab.issues" })}>
          Issues{openCount === null ? "" : ` (${openCount})`}
        </button>{" "}
        <button type="button" data-testid="tab-help" onClick={() => desk.send({ type: "tab.help" })}>
          Help
        </button>{" "}
        <button type="button" data-testid="tab-settings" onClick={() => desk.send({ type: "tab.settings" })}>
          Settings
        </button>
      </nav>
      {issues && <IssuesPage key={issues.sessionId} actor={issues} />}
      {help && <HelpPage key={help.sessionId} actor={help} />}
      {settings && <SettingsPage key={settings.sessionId} actor={settings} />}
    </div>
  );
}
