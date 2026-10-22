import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Properties;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Fixed loopback SELECT 1. Credentials are exactly two stdin lines, never command arguments. */
public final class JdbcSmoke {
    public static void main(String[] args) {
        final PrintStream report = System.out;
        // Vendor driver logging cannot write credentials or error detail to the calling terminal.
        PrintStream discard = new PrintStream(new OutputStream() { public void write(int b) {} });
        System.setOut(discard); System.setErr(discard);
        ExecutorService task = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; });
        String outcome = "failed";
        final java.util.concurrent.atomic.AtomicReference<String> stage = new java.util.concurrent.atomic.AtomicReference<String>("credentials");
        String errorClass = "unknown";
        String failureKind = "unclassified";
        int exit = 1;
        try {
            final boolean metadata = args.length == 1 && args[0].equals("--metadata");
            if (args.length > 1 || (args.length == 1 && !metadata)) throw new IllegalArgumentException();
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            final String user = input.readLine(), password = input.readLine();
            if (user == null || password == null || user.isEmpty() || password.isEmpty()) throw new IllegalArgumentException();
            Future<String> work = task.submit(new Callable<String>() {
                public String call() throws Exception {
                    stage.set("load-driver");
                    Class.forName("com.zetaris.lightning.jdbc.LightningDriver");
                    boolean loginTimeout = true, queryTimeout = true;
                    try { DriverManager.setLoginTimeout(5); } catch (Exception unsupported) { loginTimeout = false; }
                    Properties credentials = new Properties(); credentials.setProperty("user", user); credentials.setProperty("password", password); credentials.setProperty("loginTimeout", "5");
                    stage.set("connect");
                    try (Connection connection = DriverManager.getConnection("jdbc:zetaris:lightning@localhost:10000", credentials);
                         Statement statement = connection.createStatement()) {
                        try { statement.setQueryTimeout(5); } catch (Exception unsupported) { queryTimeout = false; }
                        int rows = 0, columns = 0; boolean selectOne = false;
                        stage.set("query");
                        try (ResultSet result = statement.executeQuery("SELECT 1 AS boopy_probe")) {
                            columns = result.getMetaData().getColumnCount();
                            while (result.next()) { rows++; if (rows > 10) throw new IllegalStateException(); selectOne = result.getInt(1) == 1; }
                        }
                        if (rows != 1 || columns != 1 || !selectOne) throw new IllegalStateException();
                        int schemaCount = 0; String version = "not-requested";
                        if (metadata) {
                            stage.set("metadata");
                            DatabaseMetaData details = connection.getMetaData();
                            version = safe(details.getDriverVersion());
                            try (ResultSet schemas = details.getSchemas()) { while (schemaCount < 100 && schemas.next()) schemaCount++; }
                        }
                        return "{\"synthetic\":true,\"outcome\":\"passed\",\"query\":\"select-one\",\"rows\":" + rows +
                            ",\"columns\":" + columns + ",\"loginTimeoutConfigured\":" + loginTimeout + ",\"queryTimeoutConfigured\":" + queryTimeout +
                            ",\"totalDeadlineMs\":20000,\"schemaCount\":" + schemaCount + ",\"driverVersion\":\"" + version + "\"}";
                    }
                }
            });
            try { report.println(work.get(20, TimeUnit.SECONDS)); exit = 0; }
            catch (TimeoutException timeout) { outcome = "timeout"; work.cancel(true); }
        } catch (Throwable failure) {
            Throwable cause = failure;
            for (int depth = 0; depth < 8 && cause.getCause() != null; depth++) cause = cause.getCause();
            errorClass = safe(cause.getClass().getSimpleName());
            String message = cause.getMessage() == null ? "" : cause.getMessage().toLowerCase(java.util.Locale.ROOT);
            for (String candidate : new String[]{"connection refused", "connection reset", "broken pipe", "invalid argument", "network is unreachable", "operation not permitted"})
                if (message.contains(candidate)) failureKind = candidate.replace(' ', '-');
        }
        finally { task.shutdownNow(); }
        if (exit != 0) report.println("{\"synthetic\":true,\"outcome\":\"" + outcome + "\",\"query\":\"select-one\",\"totalDeadlineMs\":20000,\"stage\":\"" + stage.get() + "\",\"errorClass\":\"" + errorClass + "\",\"failureKind\":\"" + failureKind + "\"}");
        // Bound the process even when the vendor driver leaves non-daemon threads running.
        System.exit(exit);
    }
    private static String safe(String value) {
        if (value == null) return "unknown";
        String cleaned = value.replaceAll("[^a-zA-Z0-9._+-]", "_");
        return cleaned.substring(0, Math.min(64, cleaned.length()));
    }
}
