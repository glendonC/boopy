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
            if ((args.length != 1 && args.length != 2) || !Arrays.asList("discover", "register", "join", "provision-reader", "verify-reader", "reference").contains(args[0])) throw new IllegalArgumentException();
            final String mode = args[0];
            final String referenceId = args.length == 2 ? args[1] : "Q25391";
            if (!Arrays.asList("Q25391", "Q8514", "Q71516").contains(referenceId) || (!mode.equals("reference") && args.length != 1)) throw new IllegalArgumentException();
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            final String user = input.readLine(), password = input.readLine();
            if (user == null || password == null || user.isEmpty() || password.isEmpty()) throw new IllegalArgumentException();
            final String readerUser = mode.equals("provision-reader") ? input.readLine() : null;
            final String readerPassword = mode.equals("provision-reader") ? input.readLine() : null;
            Future<String> job = executor.submit(() -> {
                Class.forName("com.zetaris.lightning.jdbc.LightningDriver");
                DriverManager.setLoginTimeout(5);
                Properties authentication = new Properties(); authentication.setProperty("user", user); authentication.setProperty("password", password);
                stage.set("connect");
                try (Connection connection = DriverManager.getConnection("jdbc:zetaris:lightning@localhost:10000", authentication); Statement statement = connection.createStatement()) {
                    statement.setQueryTimeout(15);
                    stage.set(mode);
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
