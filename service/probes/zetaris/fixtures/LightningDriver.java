package com.zetaris.lightning.jdbc;
import java.lang.reflect.Proxy;
import java.sql.*;
import java.util.Properties;
import java.util.logging.Logger;
public final class LightningDriver implements Driver {
  static { try { DriverManager.registerDriver(new LightningDriver()); } catch (SQLException error) { throw new RuntimeException(error); } }
  public Connection connect(String url, Properties info) throws SQLException {
    System.out.println(info.getProperty("password")); System.err.println(info.getProperty("user"));
    if (!"synthetic-password".equals(info.getProperty("password"))) throw new SQLException("sensitive-" + info.getProperty("password"));
    if ("synthetic-hang".equals(info.getProperty("user"))) { try { Thread.sleep(60000); } catch (InterruptedException ignored) {} }
    return proxy(Connection.class, (object, method, args) -> {
      if (method.getName().equals("createStatement")) return proxy(Statement.class, (s, m, a) -> {
        if (m.getName().equals("setQueryTimeout")) throw new SQLFeatureNotSupportedException();
        if (m.getName().equals("executeQuery")) {
          if (!"SELECT 1 AS boopy_probe".equals(a[0])) throw new SQLException("unexpected query");
          final int[] reads = {0};
          return proxy(ResultSet.class, (r, n, b) -> {
            if (n.getName().equals("next")) return reads[0]++ == 0;
            if (n.getName().equals("getInt")) return 1;
            if (n.getName().equals("getMetaData")) return proxy(ResultSetMetaData.class, (v, w, x) -> w.getName().equals("getColumnCount") ? 1 : null);
            return null;
          });
        }
        return null;
      });
      if (method.getName().equals("getMetaData")) return proxy(DatabaseMetaData.class, (s, m, a) -> {
        if (m.getName().equals("getDriverVersion")) return "synthetic-0.1";
        if (m.getName().equals("getSchemas")) return proxy(ResultSet.class, (r,n,b) -> n.getName().equals("next") ? false : null);
        return null;
      });
      return null;
    });
  }
  @SuppressWarnings("unchecked") private static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) { return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler); }
  public boolean acceptsURL(String url) { return url.equals("jdbc:zetaris:lightning@localhost:10000"); }
  public DriverPropertyInfo[] getPropertyInfo(String u, Properties p) { return new DriverPropertyInfo[0]; }
  public int getMajorVersion(){return 0;} public int getMinorVersion(){return 1;} public boolean jdbcCompliant(){return false;} public Logger getParentLogger(){return Logger.getGlobal();}
}
