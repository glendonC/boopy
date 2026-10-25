import java.io.*;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;

/** Fixed isolated synthetic namespaces only; never accepts SQL or credentials in arguments. */
public final class JdbcFederation {
    private static final String SELECTED = "BOOPY_SELECTED";
    private static final String REFERENCE = "BOOPY_REFERENCE";
    private static final String ROOT = "service/probes/zetaris/";
    public static void main(String[] args) {
        PrintStream report = System.out;
        PrintStream discard = new PrintStream(new OutputStream() { public void write(int value) {} });
        System.setOut(discard); System.setErr(discard);
        ExecutorService executor = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; });
        java.util.concurrent.atomic.AtomicReference<String> stage = new java.util.concurrent.atomic.AtomicReference<>("credentials");
        int exit = 1;
        try {
            if ((args.length != 1 && args.length != 2) || !Arrays.asList("discover", "register", "join", "provision-reader", "verify-reader", "reference", "register-terms", "provision-practice", "verify-practice", "term-pick", "practice-stage", "term-pick-check", "practice-stage-check").contains(args[0])) throw new IllegalArgumentException();
            final String mode = args[0];
            final boolean practice = TermPractice.MODES.contains(mode);
            final String referenceId = args.length == 2 && !practice ? args[1] : "Q25391";
            if (practice ? args.length != 1 : !Arrays.asList("Q25391", "Q8514", "Q71516").contains(referenceId) || (!mode.equals("reference") && args.length != 1)) throw new IllegalArgumentException();
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            final String user = input.readLine(), password = input.readLine();
            if (user == null || password == null || user.isEmpty() || password.isEmpty()) throw new IllegalArgumentException();
            final boolean provision = mode.equals("provision-reader") || mode.equals("provision-practice");
            final String readerUser = provision ? input.readLine() : null;
            final String readerPassword = provision ? input.readLine() : null;
            final List<String[]> records = TermPractice.REQUESTS.contains(mode) ? TermPractice.records(input) : null;
            Future<String> job = executor.submit(() -> {
                Class.forName("com.zetaris.lightning.jdbc.LightningDriver");
                // The driver's login timeout is also its socket timeout; a pick plans a larger query.
                DriverManager.setLoginTimeout(practice ? 30 : 5);
                Properties authentication = new Properties(); authentication.setProperty("user", user); authentication.setProperty("password", password);
                stage.set("connect");
                try (Connection connection = DriverManager.getConnection("jdbc:zetaris:lightning@localhost:10000", authentication); Statement statement = connection.createStatement()) {
                    statement.setQueryTimeout(15);
                    stage.set(mode);
                    if (practice) return TermPractice.run(mode, connection, statement, readerUser, readerPassword, records);
                    if (mode.equals("provision-reader")) {
                        if (!"boopy-reference-1970-01-01@example.invalid".equals(readerUser) || readerPassword==null || !readerPassword.matches("[A-Za-z0-9$@!%*?&]{8,128}")) throw new IllegalArgumentException();
                        try { statement.execute("ADD USER WITH (email '"+readerUser+"', name 'Boopy reference reader', level 'general', password '"+readerPassword+"')"); }
                        catch(SQLException exists){String message=String.valueOf(exists.getMessage()).toLowerCase(Locale.ROOT);if(!message.contains("already exists") || !message.contains(readerUser))throw exists;}
                        statement.execute("GRANT SELECT ON LIGHTNING DATABASE TABLE "+REFERENCE+".wikidata_reference TO USER '"+readerUser+"'");
                        return "{\"mode\":\"provision-reader\",\"referenceOnlyGrant\":true}";
                    }
                    if (mode.equals("reference")) return referenceResult(statement, referenceId);
                    if (mode.equals("verify-reader")) {
                        referenceResult(statement, "Q25391");
                        boolean denied=false;
                        try(ResultSet forbidden=statement.executeQuery("SELECT source_id FROM "+SELECTED+".selected_context_bound LIMIT 1")) {while(forbidden.next()){} }
                        catch(SQLException refusal){String message=String.valueOf(refusal.getMessage()).toLowerCase(Locale.ROOT);denied=message.contains("permission")||message.contains("denied")||message.contains("not authorized");}
                        if(!denied)throw new IllegalStateException();
                        return "{\"mode\":\"verify-reader\",\"referenceReadPassed\":true,\"selectedContextReadDenied\":true}";
                    }
                    if (mode.equals("discover")) {
                        int count = 0; boolean selected=false, reference=false;
                        try (ResultSet result = statement.executeQuery("SHOW DATASOURCES")) { while (result.next()) { if (++count > 100) throw new IllegalStateException(); for(int col=1;col<=result.getMetaData().getColumnCount();col++){String name=String.valueOf(result.getObject(col));selected|=name.equalsIgnoreCase(SELECTED);reference|=name.equalsIgnoreCase(REFERENCE);} } }
                        return "{\"mode\":\"discover\",\"datasourceCount\":" + count + ",\"selectedDatabasePresent\":"+selected+",\"referenceDatabasePresent\":"+reference+"}";

                    }
                    if (mode.equals("register")) {
                        // Names are reserved for this isolated rehearsal. No DROP/overwrite or broad discovery output.
                        Set<String> sources = new HashSet<>();
                        try (ResultSet result = statement.executeQuery("SHOW DATASOURCES")) {
                            int rows = 0;
                            while (result.next()) { if (++rows > 100) throw new IllegalStateException(); for (int col=1; col<=result.getMetaData().getColumnCount(); col++) sources.add(String.valueOf(result.getObject(col)).toUpperCase(Locale.ROOT)); }
                        }
                        for (String source : new String[]{SELECTED, REFERENCE})
                            if (!sources.contains(source)) {
                                stage.set("create-source");
                                try { statement.execute("CREATE LIGHTNING DATABASE " + source + " DESCRIBE BY \"Boopy isolated 1970-01-01 source\""); }
                                catch(SQLException exists) {String message=String.valueOf(exists.getMessage()).toLowerCase(Locale.ROOT);if(!message.contains("already exists") || !message.contains(source.toLowerCase(Locale.ROOT)))throw exists;}
                            }
                        for (String[] table : new String[][]{{SELECTED,"selected_context_bound","selected_context_bound.csv"},{REFERENCE,"wikidata_reference","wikidata_reference.csv"}}) {
                            stage.set("register-table");
                            try { statement.execute("CREATE LIGHTNING FILESTORE TABLE " + table[1] + " FROM " + table[0] + " FORMAT CSV OPTIONS (PATH \"" + ROOT + table[2] + "\", header \"true\", inferSchema \"false\")"); }
                            catch(SQLException exists) {String message=String.valueOf(exists.getMessage()).toLowerCase(Locale.ROOT);if(!message.contains("already exists") || !message.contains(table[1]))throw exists;}

                        }
                        return "{\"mode\":\"register\",\"isolatedSources\":2}";
                    }
                    String sql = "SELECT c.source_id, c.package_id, c.evidence_id, c.revision_id, c.captured_at, c.human_verification, c.disposition, CAST(c.model_confidence AS DOUBLE) AS model_confidence, r.source_id AS reference_source_id, r.reference_id, r.korean_term, r.english_gloss, r.reference_version, r.updated_at, r.reference_status, r.reference_url, r.license, c.source_record_sha256, c.concept_key FROM " + SELECTED + ".selected_context_bound c JOIN " + REFERENCE + ".wikidata_reference r ON c.concept_key = r.concept_key WHERE c.export_grant_id = 'synthetic-selected-grant-1970-01-01' AND (c.superseded_by IS NULL OR c.superseded_by = '') AND c.disposition = 'context' AND c.human_verification IN ('accepted','confirmed','authored','corrected','unconfirmed') ORDER BY c.evidence_id,r.reference_id LIMIT 10";
                    StringBuilder rows = new StringBuilder(); int count=0;
                    try (ResultSet result = statement.executeQuery(sql)) {
                        String[] names={"sourceId","packageId","evidenceId","revisionId","capturedAt","humanVerification","disposition","modelConfidence","referenceSourceId","referenceId","koreanTerm","englishGloss","referenceVersion","updatedAt","referenceStatus","referenceUrl","license","sourceRecordSha256","conceptKey"};
                        while(result.next()) {
                            if(++count>10)throw new IllegalStateException();if(count>1)rows.append(',');rows.append('{');
                            for(int col=1;col<=names.length;col++) {if(col>1)rows.append(',');rows.append(quote(names[col-1])).append(':');Object value=result.getObject(col);if(value==null)rows.append("null");else if(col==8){double confidence=result.getDouble(col);if(!Double.isFinite(confidence)||confidence<0||confidence>1)throw new IllegalStateException();rows.append(confidence);}else rows.append(quote(String.valueOf(value)));}
                            rows.append('}');
                        }
                    }
                    return "{\"mode\":\"join\",\"rows\":["+rows+"]}";
                }
            });
            report.println("{\"syntheticContext\":true,\"outcome\":\"passed\",\"result\":"+job.get(60,TimeUnit.SECONDS)+"}");exit=0;
        } catch (Throwable failure) {
            Throwable cause=failure;for(int i=0;i<8&&cause.getCause()!=null;i++)cause=cause.getCause();
            String message = cause.getMessage()==null?"":cause.getMessage().toLowerCase(Locale.ROOT);
            String kind="unclassified";
            StringBuilder signals=new StringBuilder(); for(String token:new String[]{"database","datasource","table","null","catalog","syntax","unsupported","not supported","lightning","executequery","no result","default","boopy_selected","boopy_reference","already exists","not found","unrecognized","mismatched","cannot","parse","permission","reserved"}) if(message.contains(token)){if(signals.length()>0)signals.append(',');signals.append(quote(token));}
            for(String candidate:new String[]{"parse", "syntax", "not supported", "already exists", "permission", "not found", "timeout", "no viable alternative", "mismatched input"})if(message.contains(candidate))kind=candidate.replace(' ','-');
            report.println("{\"syntheticContext\":true,\"outcome\":\"failed\",\"stage\":"+quote(stage.get())+",\"failureKind\":"+quote(kind)+",\"signals\":["+signals+"],\"errorClass\":"+quote(cause.getClass().getSimpleName().replaceAll("[^a-zA-Z0-9_]","_"))+"}");

        } finally {executor.shutdownNow();}
        System.exit(exit);
    }
    private static String referenceResult(Statement statement, String referenceId) throws SQLException {
        String sql="SELECT source_id, reference_id, korean_term, english_gloss, reference_version, updated_at, reference_status, reference_url, license FROM "+REFERENCE+".wikidata_reference WHERE reference_id='"+referenceId+"' AND source_id='wikidata:"+referenceId+"' LIMIT 2";
        String[] names={"referenceSourceId","referenceId","koreanTerm","englishGloss","referenceVersion","updatedAt","referenceStatus","referenceUrl","license"};
        StringBuilder rows=new StringBuilder();int count=0;
        try(ResultSet result=statement.executeQuery(sql)){while(result.next()){if(++count>1)throw new IllegalStateException();rows.append('{');for(int col=1;col<=names.length;col++){if(col>1)rows.append(',');rows.append(quote(names[col-1])).append(':');Object value=result.getObject(col);rows.append(value==null?"null":quote(String.valueOf(value)));}rows.append('}');}}
        if(count!=1)throw new IllegalStateException();
        return "{\"mode\":\"reference\",\"rows\":["+rows+"]}";
    }
    private static String quote(String value) {
        if(value.length()>2048)throw new IllegalArgumentException();
        return "\""+value.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r").replace("\t","\\t")+"\"";
    }
}

/**
 * The reference and practice tables. The reference table holds a dated Wikidata snapshot;
 * the practice tables hold only ids, a Q-id, a language, a result, a flag and a time per spoken
 * answer, as a projection of Boopy's journal that is rewritten whole whenever it differs. Every value
 * a caller sends is checked by a fixed pattern here and again bound as a parameter; table names come
 * from a closed list. No caller SQL, host or column name.
 */
final class TermPractice {
    static final List<String> MODES = Arrays.asList("register-terms", "provision-practice", "verify-practice", "term-pick", "practice-stage", "term-pick-check", "practice-stage-check");
    static final List<String> REQUESTS = Arrays.asList("term-pick", "practice-stage", "term-pick-check", "practice-stage-check");
    static final String TERMS = "BOOPY_TERMS";
    static final String PRACTICE = "BOOPY_PRACTICE";
    static final List<String> TABLES = Arrays.asList("practice_attempt", "practice_check");
    /** The only tables any statement here writes. A "-check" mode writes CHECKS; the others ATTEMPTS. */
    static final String ATTEMPTS = "BOOPY_PRACTICE.practice_attempt", CHECKS = "BOOPY_PRACTICE.practice_check";
    static final String SHARED = "shared/boopy/";
    static final String USER = "boopy-practice-1970-01-01@example.invalid";
    static final String COLUMNS = "attempt_id, task_id, source_id, reference_id, language, result, recognition_uncertain, attempted_at";
    static final int MAX_ROWS = 500, MAX_RECALLED = 8, MAX_EXCLUDED = 64;
    static final String EVENT = "evt_[A-Za-z0-9_-]{1,64}", TASK = "tsk_[A-Za-z0-9_-]{1,64}", SOURCE = "src_[A-Za-z0-9_-]{1,64}";
    static final String QID = "Q[1-9][0-9]{0,11}", LANGUAGE = "[a-z]{2,3}(-[A-Za-z0-9]{2,8})?", RESULT = "heard|not-heard|unclear";
    static final String AT = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z", MATCH = "[\\p{L}\\p{M}\\p{N}]+([ -][\\p{L}\\p{M}\\p{N}]+)*";
    static final String[] ROW = {EVENT, TASK, SOURCE, QID, LANGUAGE, RESULT, "true|false", AT};

    /** Tab-separated request lines up to "end": one pick, recalled Q-ids, excluded task ids, rows. */
    static List<String[]> records(BufferedReader input) throws IOException {
        List<String[]> records = new ArrayList<>();
        String line;
        while ((line = input.readLine()) != null && !line.equals("end")) {
            if (records.size() > MAX_ROWS + MAX_RECALLED + MAX_EXCLUDED + 1 || line.length() > 1024) throw new IllegalArgumentException();
            records.add(line.split("\t", -1));
        }
        if (line == null) throw new IllegalArgumentException();
        return records;
    }

    static String run(String mode, Connection connection, Statement statement, String user, String password, List<String[]> records) throws Exception {
        if (mode.equals("register-terms")) return register(statement);
        if (mode.equals("provision-practice")) return provision(statement, user, password);
        if (mode.equals("verify-practice")) return verify(statement);
        String[] pick = null;
        List<String> recalled = new ArrayList<>(), excluded = new ArrayList<>();
        List<String[]> rows = new ArrayList<>();
        Set<String> attempts = new HashSet<>();
        for (String[] record : records) {
            String kind = record[0];
            if (kind.equals("pick") && mode.startsWith("term-pick") && pick == null && record.length == 5
                    && record[1].matches(LANGUAGE) && record[2].matches(LANGUAGE) && record[4].matches(SOURCE)
                    && (record[3].isEmpty() || record[3].length() <= 80 && record[3].matches(MATCH))) pick = record;
            else if (kind.equals("recall") && record.length == 2 && record[1].matches(QID) && !recalled.contains(record[1]) && recalled.size() < MAX_RECALLED) recalled.add(record[1]);
            else if (kind.equals("exclude") && record.length == 2 && record[1].matches(TASK) && !excluded.contains(record[1]) && excluded.size() < MAX_EXCLUDED) excluded.add(record[1]);
            else if (kind.equals("row") && record.length == 9 && rows.size() < MAX_ROWS && attempts.add(record[1])) {
                String[] row = Arrays.copyOfRange(record, 1, 9);
                for (int i = 0; i < ROW.length; i++) if (!row[i].matches(ROW[i])) throw new IllegalArgumentException();
                rows.add(row);
            } else throw new IllegalArgumentException();
        }
        boolean check = mode.endsWith("-check");
        if (mode.startsWith("term-pick") && pick == null) throw new IllegalArgumentException();
        long started = System.nanoTime();
        String staged = stage(connection, statement, check, rows);
        long stagedAt = System.nanoTime();
        if (mode.startsWith("practice-stage")) return "{\"mode\":\"" + mode + "\",\"practice\":" + staged + ",\"stageMs\":" + (stagedAt - started) / 1000000 + "}";
        String picked = pick(connection, check, pick, recalled, excluded);
        return "{\"mode\":\"" + mode + "\",\"practice\":" + staged + ",\"stageMs\":" + (stagedAt - started) / 1000000 + ",\"pickMs\":" + (System.nanoTime() - stagedAt) / 1000000 + ",\"rows\":" + picked + "}";
    }

    private static String register(Statement statement) throws SQLException {
        for (String source : new String[]{TERMS, PRACTICE}) {
            try { statement.execute("CREATE LIGHTNING DATABASE " + source + " DESCRIBE BY \"Boopy 1970-01-01 source\""); }
            catch (SQLException exists) { if (!exists(exists, source)) throw exists; }
        }
        for (String[] table : new String[][]{{TERMS, "wikidata_term"}, {PRACTICE, "practice_attempt"}, {PRACTICE, "practice_check"}}) {
            try { statement.execute("CREATE LIGHTNING FILESTORE TABLE " + table[1] + " FROM " + table[0] + " FORMAT CSV OPTIONS (PATH \"" + SHARED + table[1] + "\", header \"true\", inferSchema \"false\")"); }
            catch (SQLException exists) { if (!exists(exists, table[1])) throw exists; }
        }
        return "{\"mode\":\"register-terms\",\"tables\":3}";
    }

    private static String provision(Statement statement, String user, String password) throws SQLException {
        if (!USER.equals(user) || password == null || !password.matches("[A-Za-z0-9$@!%*?&]{8,128}")) throw new IllegalArgumentException();
        try { statement.execute("ADD USER WITH (email '" + user + "', name 'Boopy practice', level 'general', password '" + password + "')"); }
        catch (SQLException exists) { if (!exists(exists, user)) throw exists; }
        statement.execute("GRANT SELECT ON LIGHTNING DATABASE TABLE " + TERMS + ".wikidata_term TO USER '" + user + "'");
        for (String table : TABLES) {
            statement.execute("GRANT SELECT ON LIGHTNING DATABASE TABLE " + PRACTICE + "." + table + " TO USER '" + user + "'");
            statement.execute("GRANT INSERT ON LIGHTNING DATABASE TABLE " + PRACTICE + "." + table + " TO USER '" + user + "'");
        }
        return "{\"mode\":\"provision-practice\",\"practiceGrants\":true}";
    }

    /**
     * As the practice account: its reads and the check table's rewrite pass, and reads of every other
     * table are refused. This engine build (2.4.3.1) does not check INSERT grants on filestore tables,
     * so only these fixed statements keep the account to its two practice tables, and this check writes
     * nothing outside them.
     */
    private static String verify(Statement statement) throws SQLException {
        long terms = count(statement, TERMS + ".wikidata_term");
        for (String table : TABLES) count(statement, PRACTICE + "." + table);
        statement.execute("INSERT OVERWRITE TABLE " + CHECKS + " SELECT 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x' WHERE 1 = 0");
        if (count(statement, CHECKS) != 0) throw new IllegalStateException();
        boolean selected = denied(statement, "SELECT COUNT(*) FROM BOOPY_SELECTED.selected_context_bound");
        boolean oldReference = denied(statement, "SELECT COUNT(*) FROM BOOPY_REFERENCE.wikidata_reference");
        boolean scratch = denied(statement, "SELECT COUNT(*) FROM BOOPY_SCRATCH.write_probe");
        if (!selected || !oldReference || !scratch) throw new IllegalStateException();
        return "{\"mode\":\"verify-practice\",\"termRows\":" + terms + ",\"practiceReadPassed\":true,\"checkRewritePassed\":true,\"selectedContextReadDenied\":true,\"oldReferenceReadDenied\":true,\"scratchReadDenied\":true}";
    }

    /** Rewrites a practice table whole when it differs from the journal's rows. */
    private static String stage(Connection connection, Statement statement, boolean check, List<String[]> rows) throws SQLException {
        List<String> current = new ArrayList<>(), wanted = new ArrayList<>();
        try (ResultSet result = statement.executeQuery("SELECT " + COLUMNS + " FROM " + (check ? CHECKS : ATTEMPTS) + " LIMIT " + (MAX_ROWS + 1))) {
            while (result.next()) {
                if (current.size() >= MAX_ROWS) throw new IllegalStateException();
                StringBuilder line = new StringBuilder();
                for (int col = 1; col <= 8; col++) line.append(result.getString(col)).append('\t');
                current.add(line.toString());
            }
        }
        for (String[] row : rows) wanted.add(String.join("\t", row) + "\t");
        Collections.sort(current);
        Collections.sort(wanted);
        boolean same = current.equals(wanted);
        if (!same && rows.isEmpty())
            statement.execute(check
                ? "INSERT OVERWRITE TABLE " + CHECKS + " SELECT 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x' WHERE 1 = 0"
                : "INSERT OVERWRITE TABLE " + ATTEMPTS + " SELECT 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x' WHERE 1 = 0");
        else if (!same) {
            StringBuilder sql = new StringBuilder(check ? "INSERT OVERWRITE TABLE " + CHECKS + " VALUES " : "INSERT OVERWRITE TABLE " + ATTEMPTS + " VALUES ");
            for (int i = 0; i < rows.size(); i++) sql.append(i == 0 ? "" : ", ").append("(?, ?, ?, ?, ?, ?, ?, ?)");
            try (PreparedStatement insert = connection.prepareStatement(sql.toString())) {
                int index = 1;
                for (String[] row : rows) for (String value : row) insert.setString(index++, value);
                insert.execute();
            }
        }
        return "{\"tableRows\":" + current.size() + ",\"journalRows\":" + rows.size() + ",\"restaged\":" + !same + "}";
    }

    /**
     * One query: the concepts whose label or alias in the person's language has exactly the model's
     * match key, plus the Q-ids recalled from earlier practice, each with its label in the target
     * language, its label and description in the person's language, and the practice record for it
     * in the target language (excluded tasks left out), ordered subject first, then a not-heard last
     * result, then more not-heard. The why code is derived here from that record.
     */
    private static String pick(Connection connection, boolean check, String[] pick, List<String> recalled, List<String> excluded) throws SQLException {
        String terms = TERMS + ".wikidata_term", practice = check ? CHECKS : ATTEMPTS;
        String keep = "language = ?" + (excluded.isEmpty() ? "" : " AND task_id NOT IN (" + marks(excluded.size()) + ")");
        String matched = "CASE WHEN language = ? AND kind IN ('label', 'alias') AND match_key = ? THEN text END";
        // One read of each table: the item's fields by conditional aggregation, the record by group.
        String sql = "WITH item AS (SELECT reference_id, MIN(" + matched + ") AS matched_text, "
            + "MAX(CASE WHEN language = ? AND kind = 'label' THEN text END) AS term, "
            + "MAX(CASE WHEN language = ? AND kind = 'label' THEN text END) AS gloss, "
            + "MAX(CASE WHEN language = ? AND kind = 'description' THEN text END) AS description, "
            + "MAX(source_id) AS source_id, MAX(revision_id) AS revision_id, MAX(modified_at) AS modified_at, MAX(retrieved_at) AS retrieved_at, "
            + "MAX(reference_url) AS reference_url, MAX(license) AS license, MAX(status) AS status FROM " + terms + " GROUP BY reference_id "
            + "HAVING MIN(" + matched + ") IS NOT NULL" + (recalled.isEmpty() ? "" : " OR reference_id IN (" + marks(recalled.size()) + ")") + "), "
            + "record AS (SELECT reference_id, COUNT(*) AS attempts, SUM(CASE WHEN result = 'not-heard' THEN 1 ELSE 0 END) AS not_heard, "
            + "SUM(CASE WHEN source_id = ? THEN 1 ELSE 0 END) AS on_source, MAX(attempted_at) AS last_at, "
            + "MAX(named_struct('at', attempted_at, 'id', attempt_id, 'result', result)).result AS last_result FROM " + practice + " WHERE " + keep + " GROUP BY reference_id) "
            + "SELECT i.reference_id, CASE WHEN i.matched_text IS NULL THEN 'recalled' ELSE 'subject' END, i.matched_text, i.term, i.gloss, i.description, i.source_id, i.revision_id, i.modified_at, i.retrieved_at, i.reference_url, i.license, i.status, "
            + "COALESCE(r.attempts, 0), COALESCE(r.not_heard, 0), COALESCE(r.on_source, 0), r.last_at, r.last_result, "
            + "CASE WHEN r.last_result = 'not-heard' THEN 'not-heard-before' WHEN r.last_result = 'unclear' THEN 'unclear-before' WHEN r.last_result = 'heard' THEN 'heard-before' ELSE 'new' END "
            + "FROM item i LEFT JOIN record r ON r.reference_id = i.reference_id "
            + "ORDER BY CASE WHEN i.matched_text IS NULL THEN 1 ELSE 0 END, CASE WHEN r.last_result = 'not-heard' THEN 0 ELSE 1 END, COALESCE(r.not_heard, 0) DESC, i.reference_id LIMIT 9";
        String[] names = {"referenceId", "matched", "matchedText", "term", "gloss", "description", "referenceSourceId", "revisionId", "modifiedAt", "retrievedAt", "referenceUrl", "license", "status", "attempts", "notHeard", "onSource", "lastAt", "lastResult", "why"};
        StringBuilder rows = new StringBuilder("[");
        try (PreparedStatement query = connection.prepareStatement(sql)) {
            int index = 1;
            query.setString(index++, pick[2]);
            query.setString(index++, pick[3]);
            query.setString(index++, pick[1]);
            query.setString(index++, pick[2]);
            query.setString(index++, pick[2]);
            query.setString(index++, pick[2]);
            query.setString(index++, pick[3]);
            for (String id : recalled) query.setString(index++, id);
            query.setString(index++, pick[4]);
            query.setString(index++, pick[1]);
            for (String id : excluded) query.setString(index++, id);
            query.setQueryTimeout(15);
            try (ResultSet result = query.executeQuery()) {
                int count = 0;
                while (result.next()) {
                    if (++count > 9) throw new IllegalStateException();
                    rows.append(count > 1 ? "," : "").append('{');
                    for (int col = 1; col <= names.length; col++) {
                        Object value = result.getObject(col);
                        rows.append(col > 1 ? "," : "").append(quote(names[col - 1])).append(':');
                        if (value == null) rows.append("null");
                        else if (col >= 14 && col <= 16) rows.append(Long.parseLong(String.valueOf(value)));
                        else rows.append(quote(String.valueOf(value)));
                    }
                    rows.append('}');
                }
            }
        }
        return rows.append(']').toString();
    }

    private static String marks(int count) {
        StringBuilder marks = new StringBuilder();
        for (int i = 0; i < count; i++) marks.append(i == 0 ? "?" : ", ?");
        return marks.toString();
    }

    private static long count(Statement statement, String table) throws SQLException {
        try (ResultSet result = statement.executeQuery("SELECT COUNT(*) FROM " + table)) {
            if (!result.next()) throw new IllegalStateException();
            return result.getLong(1);
        }
    }

    private static boolean denied(Statement statement, String sql) {
        try {
            if (statement.execute(sql)) try (ResultSet result = statement.getResultSet()) { while (result.next()) {} }
            return false;
        } catch (SQLException refusal) {
            String message = String.valueOf(refusal.getMessage()).toLowerCase(Locale.ROOT);
            return message.contains("does not have privileges") || message.contains("permission") || message.contains("denied") || message.contains("not authorized");
        }
    }

    private static boolean exists(SQLException failure, String name) {
        String message = String.valueOf(failure.getMessage()).toLowerCase(Locale.ROOT);
        return message.contains("already exists") && message.contains(name.toLowerCase(Locale.ROOT));
    }

    private static String quote(String value) {
        if (value.length() > 2048) throw new IllegalArgumentException();
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\"";
    }
}
