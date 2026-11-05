import { q } from './db.js';

export function createAudit(db, clock) {
  return {
    log(kind, { incidentId = null, actor = 'system', data = {} } = {}) {
      q.run(db, 'INSERT INTO audit_log (ts, incident_id, kind, actor, data_json) VALUES (?, ?, ?, ?, ?)', clock.iso(), incidentId, kind, actor, JSON.stringify(data));
    },
    forIncident(incidentId) {
      return q.all(db, 'SELECT * FROM audit_log WHERE incident_id = ? ORDER BY id', incidentId).map(parse);
    },
    all() {
      return q.all(db, 'SELECT * FROM audit_log ORDER BY id').map(parse);
    },
  };
}
const parse = (r) => ({ ...r, data: JSON.parse(r.data_json) });
