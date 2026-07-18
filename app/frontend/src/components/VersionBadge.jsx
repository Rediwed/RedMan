import { APP_VERSION } from '../version.js';
import './VersionBadge.css';

export default function VersionBadge() {
  return <div className="version-badge" title="RedMan application version">v{APP_VERSION}</div>;
}
