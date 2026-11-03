// ClosedBot para Windows: hace que ClosedBot se use como una app de escritorio.
//
//   - Arranca el servidor de ClosedBot sin ventana de consola.
//   - Abre la interfaz en su propia ventana (Edge o Chrome en modo app, con un perfil aparte),
//     entrando sola con un código de un solo uso.
//   - Deja un icono en la bandeja para abrirla, iniciarla con Windows, ver el registro o salir.
//     Al cerrar la ventana, el servidor sigue funcionando para las rutinas.
//
// Lo compila Instalar-escritorio.cmd en el propio equipo, con el compilador de C# que trae
// .NET Framework 4. Por eso está escrito en C# 5: es lo que entiende ese compilador.
//
//   ClosedBot.exe               abre ClosedBot (o trae su ventana al frente)
//   ClosedBot.exe /sinventana   arranca solo en la bandeja (lo usa el inicio con Windows)
//   ClosedBot.exe /salir        cierra la ClosedBot abierta y espera a que termine
//   ClosedBot.exe /instalar     crea los accesos directos del escritorio y del menú Inicio
//   ClosedBot.exe /desinstalar  quita los accesos directos
//
// Hasta la versión 0.2 la app se llamaba Cuadrilla (Cuadrilla.exe). Este programa cierra esa versión
// si sigue abierta y, al instalar, reemplaza sus accesos directos y borra su carpeta local.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("ClosedBot")]
[assembly: AssemblyProduct("ClosedBot")]
[assembly: AssemblyDescription("Tu equipo personal de agentes de IA")]
[assembly: AssemblyVersion("0.6.4.0")]
[assembly: AssemblyFileVersion("0.6.4.0")]

namespace ClosedBotEscritorio
{
    static class Program
    {
        const string MutexName = @"Local\ClosedBot-Escritorio";
        const string OpenSignalName = @"Local\ClosedBot-Abrir";
        const string QuitSignalName = @"Local\ClosedBot-Salir";
        // Los del lanzador de antes del cambio de nombre (Cuadrilla.exe, hasta la 0.2).
        const string LegacyMutexName = @"Local\Cuadrilla-Escritorio";
        const string LegacyQuitSignalName = @"Local\Cuadrilla-Salir";

        [STAThread]
        static int Main(string[] args)
        {
            bool hidden = false, quit = false, install = false, uninstall = false;
            foreach (string raw in args)
            {
                string arg = raw.Trim().TrimStart('/', '-').ToLowerInvariant();
                if (arg == "sinventana" || arg == "sin-ventana") hidden = true;
                else if (arg == "salir") quit = true;
                else if (arg == "instalar") install = true;
                else if (arg == "desinstalar") uninstall = true;
            }

            try { Native.SetProcessDPIAware(); }
            catch (Exception) { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            ServicePointManager.Expect100Continue = false;

            Paths paths;
            try
            {
                paths = new Paths();
            }
            catch (Exception error)
            {
                Dialogs.Warn(error is UserError ? error.Message : "No pude leer la instalación de ClosedBot.\n\n" + error.Message);
                return 1;
            }

            if (install || uninstall)
            {
                try
                {
                    if (install)
                    {
                        CloseLegacy();
                        Shortcuts.Install(paths);
                        Legacy.CleanLocalDir(paths);
                    }
                    else Shortcuts.Uninstall();
                    return 0;
                }
                catch (Exception error)
                {
                    Dialogs.Warn("No pude " + (install ? "crear" : "quitar") + " los accesos directos de ClosedBot.\n\n" + error.Message);
                    return 1;
                }
            }

            // Las señales se crean antes del mutex para que ninguna llamada de otra instancia se pierda.
            using (var openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, OpenSignalName))
            using (var quitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, QuitSignalName))
            {
                bool first;
                using (var mutex = new Mutex(true, MutexName, out first))
                {
                    if (!first)
                    {
                        if (quit) return WaitUntilClosed(mutex, quitSignal);
                        if (!hidden) WakeRunning(paths, openSignal);
                        return 0;
                    }
                    try
                    {
                        // La versión con el nombre anterior usaría el mismo puerto: se cierra antes.
                        bool legacyClosed = CloseLegacy();
                        if (quit) return legacyClosed ? 0 : 2;
                        using (var app = new TrayApp(paths, !hidden, openSignal, quitSignal))
                        {
                            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e) { app.Unexpected(e.Exception); };
                            Application.Run(app);
                        }
                        return 0;
                    }
                    catch (Exception error)
                    {
                        Dialogs.Warn("ClosedBot se cerró por un error inesperado.\n\n" + error.Message);
                        return 1;
                    }
                    finally
                    {
                        mutex.ReleaseMutex();
                    }
                }
            }
        }

        /// Otra ClosedBot ya está en la bandeja: trae su ventana al frente o le pide que la abra.
        static void WakeRunning(Paths paths, EventWaitHandle openSignal)
        {
            Native.AllowSetForegroundWindow(Native.ASFW_ANY);
            IntPtr window = Browser.FindWindow(paths);
            if (window != IntPtr.Zero) Native.Focus(window);
            else openSignal.Set();
        }

        /// Cierra Cuadrilla.exe (esta app antes del cambio de nombre) si está abierto y espera a que termine.
        /// Devuelve false si no terminó a tiempo.
        static bool CloseLegacy()
        {
            try
            {
                EventWaitHandle signal;
                if (!EventWaitHandle.TryOpenExisting(LegacyQuitSignalName, out signal)) return true;
                using (signal)
                {
                    Mutex legacy;
                    if (!Mutex.TryOpenExisting(LegacyMutexName, out legacy)) return true;
                    using (legacy)
                    {
                        signal.Set();
                        try
                        {
                            if (!legacy.WaitOne(TimeSpan.FromSeconds(40))) return false;
                        }
                        catch (AbandonedMutexException)
                        {
                            // Terminó sin soltarlo: igual quedó libre y ahora es nuestro.
                        }
                        legacy.ReleaseMutex();
                        return true;
                    }
                }
            }
            catch (Exception)
            {
                return true;
            }
        }

        /// /salir: pide a la ClosedBot abierta que se cierre y espera a que suelte el mutex.
        static int WaitUntilClosed(Mutex mutex, EventWaitHandle quitSignal)
        {
            CloseLegacy();
            quitSignal.Set();
            try
            {
                if (!mutex.WaitOne(TimeSpan.FromSeconds(40))) return 2;
            }
            catch (AbandonedMutexException)
            {
                // La otra terminó sin soltarlo: igual quedó libre y ahora es nuestro.
            }
            mutex.ReleaseMutex();
            return 0;
        }
    }

    /// Un problema que se le explica al usuario tal cual.
    sealed class UserError : Exception
    {
        public UserError(string message) : base(message) { }
    }

    /// Rutas y ajustes de esta instalación.
    sealed class Paths
    {
        public readonly string Exe;
        public readonly string AppDir;
        public readonly string ServerScript;
        public readonly string IconFile;
        public readonly string Version;
        public readonly string LocalDir;
        public readonly string LogFile;
        public readonly string ProfileDir;
        public readonly string TipMarker;
        public readonly string StartupMarker;
        /// Carpeta local de la versión con el nombre anterior (%LOCALAPPDATA%\Cuadrilla).
        public readonly string LegacyLocalDir;
        public readonly int Port;
        public readonly string BaseUrl;

        public Paths()
        {
            Exe = Application.ExecutablePath;
            AppDir = FindAppDir(Path.GetDirectoryName(Exe));
            if (AppDir == null)
                throw new UserError("No encuentro los archivos de ClosedBot junto a este programa:\n" + Exe + "\n\nVuelve a abrir Instalar-escritorio.cmd en la carpeta de ClosedBot.");
            ServerScript = Path.Combine(AppDir, "dist", "src", "server.js");
            IconFile = Path.Combine(AppDir, "public", "icons", "closedbot.ico");
            Version = ReadVersion(Path.Combine(AppDir, "package.json"));
            LocalDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClosedBot");
            Directory.CreateDirectory(LocalDir);
            LogFile = Path.Combine(LocalDir, "closedbot.log");
            ProfileDir = Path.Combine(LocalDir, "ventana");
            TipMarker = Path.Combine(LocalDir, "aviso-bandeja.txt");
            StartupMarker = Path.Combine(LocalDir, "inicio-con-windows.txt");
            LegacyLocalDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cuadrilla");
            Port = ReadPort();
            BaseUrl = "http://127.0.0.1:" + Port.ToString(CultureInfo.InvariantCulture);
        }

        static string FindAppDir(string start)
        {
            DirectoryInfo dir = new DirectoryInfo(start);
            for (int level = 0; level < 4 && dir != null; level++, dir = dir.Parent)
            {
                string package = Path.Combine(dir.FullName, "package.json");
                if (File.Exists(package) && Regex.IsMatch(File.ReadAllText(package), "\"name\"\\s*:\\s*\"(closedbot|cuadrilla)\"")) return dir.FullName;
            }
            return null;
        }

        static string ReadVersion(string package)
        {
            Match match = Regex.Match(File.ReadAllText(package), "\"version\"\\s*:\\s*\"([^\"]+)\"");
            return match.Success ? match.Groups[1].Value : "?";
        }

        static int ReadPort()
        {
            int port;
            string raw = Environment.GetEnvironmentVariable("CLOSEDBOT_PORT");
            if (string.IsNullOrEmpty(raw)) raw = Environment.GetEnvironmentVariable("CUADRILLA_PORT");
            if (!string.IsNullOrEmpty(raw) && int.TryParse(raw.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out port) && port > 0 && port < 65536) return port;
            return 8787;
        }
    }

    /// Registro compartido por el lanzador y el servidor, en %LOCALAPPDATA%\ClosedBot\closedbot.log.
    sealed class Log : IDisposable
    {
        const long MaxBytes = 5L * 1024 * 1024;
        readonly object gate = new object();
        StreamWriter writer;

        public Log(string path)
        {
            try
            {
                FileInfo info = new FileInfo(path);
                if (info.Exists && info.Length > MaxBytes)
                {
                    string previous = Path.Combine(info.DirectoryName, "closedbot.anterior.log");
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(path, previous);
                }
            }
            catch (Exception)
            {
                // Si el registro está abierto en otro programa, se sigue escribiendo al final.
            }
            try
            {
                FileStream stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                writer = new StreamWriter(stream, new UTF8Encoding(false));
                writer.AutoFlush = true;
            }
            catch (Exception)
            {
                writer = null;
            }
        }

        public void Raw(string line)
        {
            lock (gate)
            {
                if (writer == null) return;
                try { writer.WriteLine(line); }
                catch (Exception) { }
            }
        }

        public void Info(string message)
        {
            Write("INFO", message);
        }

        public void Error(string message)
        {
            Write("ERROR", message);
        }

        void Write(string level, string message)
        {
            Raw("[" + DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) + "] " + level + " (escritorio) " + message);
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (writer != null) writer.Dispose();
                writer = null;
            }
        }
    }

    static class Http
    {
        /// Petición a ClosedBot en este equipo, sin proxy. Devuelve el cuerpo o null si no hubo respuesta.
        public static string Send(Paths paths, string method, string path, string controlToken, int timeoutMs, out int status)
        {
            status = 0;
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(paths.BaseUrl + path);
                request.Method = method;
                request.Proxy = null;
                request.Timeout = timeoutMs;
                request.ReadWriteTimeout = timeoutMs;
                request.KeepAlive = false;
                request.Headers["x-cuadrilla"] = "1";
                if (controlToken != null) request.Headers["x-cuadrilla-control"] = controlToken;
                if (method != "GET") request.ContentLength = 0;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return Read(response, out status);
                }
            }
            catch (WebException error)
            {
                HttpWebResponse response = error.Response as HttpWebResponse;
                if (response == null) return null;
                using (response)
                {
                    return Read(response, out status);
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        static string Read(HttpWebResponse response, out int status)
        {
            status = (int)response.StatusCode;
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }
    }

    /// El servidor de ClosedBot (node dist\src\server.js), sin ventana y atado a este programa.
    sealed class Server
    {
        readonly Paths paths;
        readonly Log log;
        readonly object gate = new object();
        readonly Queue<string> recent = new Queue<string>();
        Process process;
        IntPtr job = IntPtr.Zero;
        string token;
        bool external;

        public Server(Paths paths, Log log)
        {
            this.paths = paths;
            this.log = log;
        }

        /// Hay un servidor arrancado por este programa (puede que ya haya terminado).
        public bool Owned
        {
            get { lock (gate) return process != null; }
        }

        /// Se está usando una ClosedBot que arrancó otro (por ejemplo, con npm start).
        public bool External
        {
            get { lock (gate) return external; }
        }

        public bool HasExited
        {
            get
            {
                lock (gate)
                {
                    try { return process != null && process.HasExited; }
                    catch (Exception) { return true; }
                }
            }
        }

        public int ExitCode
        {
            get
            {
                lock (gate)
                {
                    try { return process != null && process.HasExited ? process.ExitCode : 0; }
                    catch (Exception) { return -1; }
                }
            }
        }

        /// Versión de la ClosedBot que responde en el puerto, o null si no responde ninguna.
        public string RunningVersion()
        {
            int status;
            string body = Http.Send(paths, "GET", "/api/health", null, 1500, out status);
            if (status != 200 || body == null || !Regex.IsMatch(body, "\"ok\"\\s*:\\s*true")) return null;
            Match match = Regex.Match(body, "\"version\"\\s*:\\s*\"([^\"]+)\"");
            return match.Success ? match.Groups[1].Value : null;
        }

        /// Deja ClosedBot respondiendo. Devuelve null si quedó lista, o el problema explicado.
        public string Ensure()
        {
            if (Owned && !HasExited) return null;
            if (Owned) Kill();

            string version = RunningVersion();
            if (version != null)
            {
                if (version != paths.Version)
                    return "Ya hay otra ClosedBot abierta en este equipo (versión " + version + "; esta es la " + paths.Version + ").\n\n" +
                        "Ciérrala y vuelve a abrir ClosedBot. Si la abriste desde una ventana negra (npm start), cierra esa ventana.";
                lock (gate) external = true;
                log.Info("Ya había una ClosedBot " + version + " en " + paths.BaseUrl + "; uso esa.");
                return null;
            }
            lock (gate) external = false;
            Start();
            return WaitReady(TimeSpan.FromSeconds(60));
        }

        public void ForgetExternal()
        {
            lock (gate) external = false;
        }

        void Start()
        {
            string node = Locate.Node();
            if (node == null)
                throw new UserError("No encontré Node.js en este equipo.\n\nInstálalo con «winget install OpenJS.NodeJS.LTS» y vuelve a abrir ClosedBot.");
            if (!File.Exists(paths.ServerScript))
                throw new UserError("ClosedBot aún no está compilada.\n\nAbre Instalar-escritorio.cmd en " + paths.AppDir + ".");

            string newToken = NewToken();
            ProcessStartInfo info = new ProcessStartInfo(node, "--disable-warning=ExperimentalWarning \"" + paths.ServerScript + "\"");
            info.WorkingDirectory = paths.AppDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            // Con este token el lanzador abre sesión y cierra el servidor. El servidor lo quita de su
            // entorno al arrancar, así que los agentes no lo heredan.
            info.EnvironmentVariables["CLOSEDBOT_CONTROL_TOKEN"] = newToken;

            Process started = new Process();
            started.StartInfo = info;
            started.OutputDataReceived += OnOutput;
            started.ErrorDataReceived += OnOutput;
            lock (recent) recent.Clear();
            started.Start();

            // Si este programa termina (o lo cierran a la fuerza), Windows cierra también el servidor
            // y todo lo que haya lanzado.
            IntPtr newJob = Native.CreateKillOnCloseJob();
            if (newJob != IntPtr.Zero && !Native.AssignProcessToJobObject(newJob, started.Handle))
            {
                Native.CloseHandle(newJob);
                newJob = IntPtr.Zero;
            }
            started.StandardInput.Close();
            started.BeginOutputReadLine();
            started.BeginErrorReadLine();
            lock (gate)
            {
                process = started;
                job = newJob;
                token = newToken;
            }
            log.Info("Arranqué el servidor de ClosedBot " + paths.Version + " (proceso " + started.Id + ").");
        }

        void OnOutput(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            log.Raw(e.Data);
            lock (recent)
            {
                recent.Enqueue(e.Data);
                while (recent.Count > 40) recent.Dequeue();
            }
        }

        string WaitReady(TimeSpan limit)
        {
            DateTime until = DateTime.UtcNow + limit;
            while (DateTime.UtcNow < until)
            {
                Process current;
                lock (gate) current = process;
                if (current == null) return "Se canceló el arranque de ClosedBot.";
                if (current.HasExited)
                {
                    int code = current.ExitCode;
                    Kill();
                    return Explain(code);
                }
                if (RunningVersion() != null)
                {
                    log.Info("ClosedBot está lista en " + paths.BaseUrl + ".");
                    return null;
                }
                Thread.Sleep(300);
            }
            log.Error("El servidor no respondió a tiempo; lo cierro.");
            Kill();
            return "ClosedBot tardó demasiado en arrancar.";
        }

        string Explain(int code)
        {
            string[] lines;
            lock (recent) lines = recent.ToArray();
            string output = string.Join("\n", lines);
            if (output.Contains("EADDRINUSE"))
                return "ClosedBot no pudo arrancar porque otro programa ya usa el puerto " + paths.Port + ".";
            if (output.Contains("necesita una contraseña"))
                return "ClosedBot aún no tiene contraseña.\n\nAbre Instalar-escritorio.cmd en " + paths.AppDir + " y se creará una.";
            string last = null;
            foreach (string line in lines)
                if (line.Trim().Length > 0) last = line.Trim();
            if (last != null && last.Length > 300) last = last.Substring(0, 300) + "…";
            return "ClosedBot no pudo arrancar (código " + code + ")." + (last != null ? "\n\n" + last : "");
        }

        /// Enlace de un solo uso para entrar sin contraseña, o null si este programa no arrancó el servidor.
        public string LoginLink()
        {
            string current;
            lock (gate) current = process != null ? token : null;
            if (current == null) return null;
            int status;
            string body = Http.Send(paths, "POST", "/api/control/login-link", current, 3000, out status);
            Match match = body == null ? Match.Empty : Regex.Match(body, "\"path\"\\s*:\\s*\"(/\\?acceso=[A-Za-z0-9_%\\-]+)\"");
            if (status == 200 && match.Success) return match.Groups[1].Value;
            log.Error("No pude pedir el acceso automático (HTTP " + status + ").");
            return null;
        }

        /// Pide al servidor propio que se cierre con calma; si no termina a tiempo, lo corta.
        public void Stop(int graceMs)
        {
            Process current;
            string currentToken;
            lock (gate)
            {
                current = process;
                currentToken = token;
            }
            if (current == null) return;
            try
            {
                if (!current.HasExited)
                {
                    int status;
                    Http.Send(paths, "POST", "/api/control/shutdown", currentToken, 3000, out status);
                    if (status == 200) log.Info("Le pedí al servidor que se cierre.");
                    if (!current.WaitForExit(graceMs)) log.Error("El servidor no se cerró a tiempo; lo corto.");
                }
            }
            catch (Exception error)
            {
                log.Error("Al cerrar el servidor: " + error.Message);
            }
            Kill();
        }

        /// Termina el servidor propio y todo lo que haya lanzado, y lo olvida.
        public void Kill()
        {
            Process current;
            IntPtr currentJob;
            lock (gate)
            {
                current = process;
                currentJob = job;
                process = null;
                job = IntPtr.Zero;
                token = null;
            }
            // Cerrar el job termina los procesos que queden dentro (KILL_ON_JOB_CLOSE).
            if (currentJob != IntPtr.Zero) Native.CloseHandle(currentJob);
            if (current == null) return;
            try
            {
                if (!current.WaitForExit(currentJob != IntPtr.Zero ? 3000 : 0))
                {
                    TaskKill(current.Id);
                    current.WaitForExit(5000);
                }
                // Espera a que llegue lo último que escribió. Solo con el job: así nadie más tiene la tubería abierta.
                if (currentJob != IntPtr.Zero && current.HasExited) current.WaitForExit();
            }
            catch (Exception error)
            {
                log.Error("No pude terminar el servidor: " + error.Message);
            }
            finally
            {
                current.Dispose();
            }
        }

        static void TaskKill(int processId)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo("taskkill.exe", "/PID " + processId + " /T /F");
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                using (Process killer = Process.Start(info)) killer.WaitForExit(5000);
            }
            catch (Exception) { }
        }

        static string NewToken()
        {
            byte[] bytes = new byte[32];
            using (RNGCryptoServiceProvider random = new RNGCryptoServiceProvider()) random.GetBytes(bytes);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
    }

    static class Locate
    {
        public static string Node()
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in path.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string found = Existing(part.Trim().Trim('"'), "node.exe");
                if (found != null) return found;
            }
            string[] dirs =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs"),
                Environment.GetEnvironmentVariable("NVM_SYMLINK") ?? "",
            };
            foreach (string dir in dirs)
            {
                string found = Existing(dir, "node.exe");
                if (found != null) return found;
            }
            return null;
        }

        /// Edge o, si no está, Chrome.
        public static string BrowserExe()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programsX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string found = AppPath("msedge.exe")
                ?? Existing(Path.Combine(programsX86, "Microsoft", "Edge", "Application"), "msedge.exe")
                ?? Existing(Path.Combine(programs, "Microsoft", "Edge", "Application"), "msedge.exe")
                ?? Existing(Path.Combine(local, "Microsoft", "Edge", "Application"), "msedge.exe")
                ?? AppPath("chrome.exe")
                ?? Existing(Path.Combine(programs, "Google", "Chrome", "Application"), "chrome.exe")
                ?? Existing(Path.Combine(programsX86, "Google", "Chrome", "Application"), "chrome.exe")
                ?? Existing(Path.Combine(local, "Google", "Chrome", "Application"), "chrome.exe");
            return found;
        }

        static string AppPath(string exe)
        {
            RegistryHive[] hives = { RegistryHive.CurrentUser, RegistryHive.LocalMachine };
            RegistryView[] views = { RegistryView.Registry64, RegistryView.Registry32 };
            foreach (RegistryHive hive in hives)
            {
                foreach (RegistryView view in views)
                {
                    try
                    {
                        using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                        using (RegistryKey key = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                        {
                            string value = key == null ? null : key.GetValue(null) as string;
                            if (string.IsNullOrEmpty(value)) continue;
                            value = Environment.ExpandEnvironmentVariables(value.Trim().Trim('"'));
                            if (File.Exists(value)) return value;
                        }
                    }
                    catch (Exception) { }
                }
            }
            return null;
        }

        static string Existing(string dir, string exe)
        {
            if (string.IsNullOrEmpty(dir)) return null;
            try
            {
                string candidate = Path.Combine(Environment.ExpandEnvironmentVariables(dir), exe);
                return File.Exists(candidate) ? candidate : null;
            }
            catch (ArgumentException)
            {
                return null;
            }
        }
    }

    /// La ventana de ClosedBot: Edge (o Chrome) en modo app, con un perfil solo para ella.
    static class Browser
    {
        public static void Open(Paths paths, string path, Log log)
        {
            string url = paths.BaseUrl + path;
            string exe = Locate.BrowserExe();
            if (exe == null)
            {
                log.Info("No encontré Edge ni Chrome; abro el navegador predeterminado.");
                using (Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })) { }
                return;
            }
            bool firstTime = !Directory.Exists(paths.ProfileDir);
            StringBuilder arguments = new StringBuilder();
            arguments.Append("--app=\"").Append(url).Append('"');
            arguments.Append(" --user-data-dir=\"").Append(paths.ProfileDir).Append('"');
            arguments.Append(" --no-first-run --no-default-browser-check");
            // La primera vez le damos un buen tamaño; después el navegador recuerda el que elijas.
            if (firstTime) arguments.Append(" --window-size=1200,820");
            ProcessStartInfo info = new ProcessStartInfo(exe, arguments.ToString());
            info.UseShellExecute = false;
            using (Process.Start(info)) { }
            log.Info("Abrí la ventana con " + Path.GetFileName(exe) + ".");
        }

        /// La ventana de ClosedBot si está abierta, o IntPtr.Zero.
        public static IntPtr FindWindow(Paths paths)
        {
            IntPtr found = IntPtr.Zero;
            foreach (Process process in OwnBrowsers(paths))
            {
                using (process)
                {
                    if (found != IntPtr.Zero) continue;
                    try
                    {
                        process.Refresh();
                        found = process.MainWindowHandle;
                    }
                    catch (Exception) { }
                }
            }
            return found;
        }

        public static void CloseWindows(Paths paths)
        {
            foreach (Process process in OwnBrowsers(paths))
            {
                using (process)
                {
                    try { process.CloseMainWindow(); }
                    catch (Exception) { }
                }
            }
        }

        /// Procesos principales de Edge o Chrome abiertos con el perfil de ClosedBot.
        static List<Process> OwnBrowsers(Paths paths)
        {
            List<Process> result = new List<Process>();
            string profile = paths.ProfileDir.ToLowerInvariant();
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedge.exe' OR Name = 'chrome.exe'"))
                using (ManagementObjectCollection items = searcher.Get())
                {
                    foreach (ManagementBaseObject item in items)
                    {
                        using (item)
                        {
                            string line = ((item["CommandLine"] as string) ?? "").ToLowerInvariant();
                            if (line.IndexOf(profile, StringComparison.Ordinal) < 0 || line.Contains("--type=")) continue;
                            try { result.Add(Process.GetProcessById(Convert.ToInt32(item["ProcessId"], CultureInfo.InvariantCulture))); }
                            catch (ArgumentException) { }
                        }
                    }
                }
            }
            catch (Exception) { }
            return result;
        }
    }

    /// Accesos directos del escritorio, del menú Inicio y del inicio con Windows.
    static class Shortcuts
    {
        const string FileName = "ClosedBot.lnk";
        const string LegacyFileName = "Cuadrilla.lnk";
        const string Description = "ClosedBot: tu equipo personal de agentes de IA";

        static string[] Folders
        {
            get
            {
                return new[]
                {
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    Environment.GetFolderPath(Environment.SpecialFolder.Startup),
                };
            }
        }

        static string DesktopLink
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), FileName); }
        }

        static string StartMenuLink
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), FileName); }
        }

        static string StartupLink
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), FileName); }
        }

        public static bool StartupEnabled
        {
            get { return File.Exists(StartupLink); }
        }

        public static void Install(Paths paths)
        {
            // Lo que se eligió con el nombre anterior: si se apagó el inicio con Windows, sigue apagado.
            bool legacyStartup = File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), LegacyFileName));
            bool legacyChoice = File.Exists(Path.Combine(paths.LegacyLocalDir, "inicio-con-windows.txt"));
            RemoveLegacy();
            Create(DesktopLink, paths, "");
            Create(StartMenuLink, paths, "");
            // Solo la primera vez: después se respeta lo que elijas en el menú de la bandeja.
            if (!File.Exists(paths.StartupMarker))
            {
                SetStartup(paths, legacyStartup || !legacyChoice);
                File.WriteAllText(paths.StartupMarker, "El inicio con Windows se activó al instalar. Se cambia desde el icono de la bandeja.\r\n");
            }
            else if (StartupEnabled)
            {
                SetStartup(paths, true);
            }
        }

        public static void Uninstall()
        {
            foreach (string link in new[] { DesktopLink, StartMenuLink, StartupLink })
            {
                if (File.Exists(link)) File.Delete(link);
            }
            RemoveLegacy();
        }

        /// Quita los accesos directos «Cuadrilla.lnk» de la versión con el nombre anterior.
        static void RemoveLegacy()
        {
            foreach (string folder in Folders)
            {
                string link = Path.Combine(folder, LegacyFileName);
                if (File.Exists(link)) File.Delete(link);
            }
        }

        public static void SetStartup(Paths paths, bool enabled)
        {
            if (enabled) Create(StartupLink, paths, "/sinventana");
            else if (File.Exists(StartupLink)) File.Delete(StartupLink);
        }

        static void Create(string file, Paths paths, string arguments)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            IShellLinkW link = (IShellLinkW)new ShellLink();
            try
            {
                link.SetPath(paths.Exe);
                link.SetArguments(arguments);
                link.SetWorkingDirectory(paths.AppDir);
                link.SetDescription(Description);
                link.SetIconLocation(paths.Exe, 0);
                ((IPersistFile)link).Save(file, true);
            }
            finally
            {
                Marshal.FinalReleaseComObject(link);
            }
        }
    }

    /// Lo que dejó en este equipo la versión con el nombre anterior (Cuadrilla).
    static class Legacy
    {
        /// Borra %LOCALAPPDATA%\Cuadrilla: el perfil de su ventana, su registro y sus marcas. Nada más.
        public static void CleanLocalDir(Paths paths)
        {
            string dir = paths.LegacyLocalDir;
            if (!Directory.Exists(dir)) return;
            // La ventana de la versión anterior puede tardar un poco en soltar su perfil.
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    string profile = Path.Combine(dir, "ventana");
                    if (Directory.Exists(profile)) Directory.Delete(profile, true);
                    foreach (string name in new[] { "cuadrilla.log", "cuadrilla.anterior.log", "aviso-bandeja.txt", "inicio-con-windows.txt" })
                    {
                        string file = Path.Combine(dir, name);
                        if (File.Exists(file)) File.Delete(file);
                    }
                    if (Directory.GetFileSystemEntries(dir).Length == 0) Directory.Delete(dir);
                    return;
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                Thread.Sleep(1000);
            }
        }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLink
    {
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maxPath, IntPtr findData, int flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int maxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int maxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int maxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCmd);
        void SetShowCmd(int showCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int maxIconPath, out int iconIndex);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string relativePath, int reserved);
        void Resolve(IntPtr window, int flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    static class Dialogs
    {
        public static void Warn(string message)
        {
            Show(message, MessageBoxButtons.OK);
        }

        /// Devuelve true si el usuario quiere ver el registro.
        public static bool WarnWithLog(string message)
        {
            return Show(message + "\n\n¿Quieres ver el registro?", MessageBoxButtons.YesNo) == DialogResult.Yes;
        }

        static DialogResult Show(string message, MessageBoxButtons buttons)
        {
            // La bandeja no tiene ventana: un dueño invisible "siempre visible" deja el aviso al frente.
            using (Form owner = new Form())
            {
                owner.TopMost = true;
                owner.ShowInTaskbar = false;
                return MessageBox.Show(owner, message, "ClosedBot", buttons, MessageBoxIcon.Warning);
            }
        }
    }

    /// El icono de la bandeja y todo lo que hace.
    sealed class TrayApp : ApplicationContext
    {
        readonly Paths paths;
        readonly Log log;
        readonly Server server;
        readonly EventWaitHandle openSignal;
        readonly EventWaitHandle quitSignal;
        readonly NotifyIcon tray;
        readonly ContextMenuStrip menu;
        readonly ToolStripMenuItem startupItem;
        readonly System.Windows.Forms.Timer timer;
        readonly List<DateTime> restarts = new List<DateTime>();
        bool working;
        bool wantOpen;
        bool quitting;
        DateTime nextCheck = DateTime.MinValue;

        public TrayApp(Paths paths, bool openWindow, EventWaitHandle openSignal, EventWaitHandle quitSignal)
        {
            // Para que lo que sigue a cada await vuelva a este hilo (el de la bandeja).
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
            this.paths = paths;
            this.openSignal = openSignal;
            this.quitSignal = quitSignal;
            log = new Log(paths.LogFile);
            log.Info("ClosedBot " + paths.Version + " para Windows, en " + paths.AppDir + ".");
            server = new Server(paths, log);

            menu = new ContextMenuStrip();
            ToolStripMenuItem openItem = new ToolStripMenuItem("Abrir ClosedBot");
            openItem.Font = new Font(menu.Font, FontStyle.Bold);
            openItem.Click += delegate { RequestOpen(); };
            startupItem = new ToolStripMenuItem("Iniciar con Windows");
            startupItem.Click += delegate { ToggleStartup(); };
            ToolStripMenuItem logItem = new ToolStripMenuItem("Ver registro");
            logItem.Click += delegate { OpenLog(); };
            ToolStripMenuItem quitItem = new ToolStripMenuItem("Salir");
            quitItem.Click += delegate { Quit(); };
            menu.Items.AddRange(new ToolStripItem[] { openItem, new ToolStripSeparator(), startupItem, logItem, new ToolStripSeparator(), quitItem });
            menu.Opening += delegate { startupItem.Checked = Shortcuts.StartupEnabled; };

            tray = new NotifyIcon();
            tray.Icon = LoadIcon();
            tray.Text = "ClosedBot";
            tray.ContextMenuStrip = menu;
            tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) RequestOpen(); };
            tray.BalloonTipClicked += delegate { RequestOpen(); };
            tray.Visible = true;

            timer = new System.Windows.Forms.Timer();
            timer.Interval = 500;
            timer.Tick += delegate { Tick(); };
            timer.Start();

            SystemEvents.SessionEnding += OnSessionEnding;
            wantOpen = openWindow;
            Run();
        }

        public void Unexpected(Exception error)
        {
            log.Error("Error inesperado: " + error);
        }

        void RequestOpen()
        {
            if (quitting) return;
            wantOpen = true;
            Run();
        }

        /// Arranca el servidor si hace falta y, si se pidió, abre la ventana o la trae al frente.
        async void Run()
        {
            if (working || quitting) return;
            working = true;
            string problem = null;
            try
            {
                if (!server.Owned && !server.External) SetStatus("ClosedBot · arrancando…");
                problem = await Task.Run(() => server.Ensure());
                if (problem == null && wantOpen && !quitting)
                {
                    wantOpen = false;
                    IntPtr window = await Task.Run(() => Browser.FindWindow(paths));
                    if (window != IntPtr.Zero)
                    {
                        Native.Focus(window);
                    }
                    else if (!quitting)
                    {
                        string link = await Task.Run(() => server.LoginLink());
                        if (!quitting)
                        {
                            Browser.Open(paths, link ?? "/", log);
                            ShowFirstTip();
                        }
                    }
                }
            }
            catch (Exception error)
            {
                problem = error is UserError ? error.Message : "Algo falló: " + error.Message;
                if (!(error is UserError)) log.Error(error.ToString());
            }
            if (!quitting)
            {
                if (problem != null)
                {
                    SetStatus("ClosedBot · detenida");
                    log.Error(problem.Replace("\n\n", " ").Replace("\n", " "));
                    if (Dialogs.WarnWithLog(problem)) OpenLog();
                    wantOpen = false;
                }
                else
                {
                    SetStatus("ClosedBot");
                }
            }
            working = false;
            if (wantOpen && !quitting) Run();
        }

        void Tick()
        {
            if (quitting) return;
            if (quitSignal.WaitOne(0))
            {
                log.Info("Me pidieron cerrar (ClosedBot.exe /salir).");
                Quit();
                return;
            }
            if (openSignal.WaitOne(0)) RequestOpen();
            if (working) return;
            if (server.Owned && server.HasExited)
            {
                OnServerExited();
            }
            else if (server.External && DateTime.UtcNow >= nextCheck)
            {
                nextCheck = DateTime.UtcNow.AddSeconds(15);
                CheckExternal();
            }
        }

        void OnServerExited()
        {
            int code = server.ExitCode;
            server.Kill();
            log.Error("El servidor se detuvo solo (código " + code + ").");
            DateTime now = DateTime.UtcNow;
            restarts.RemoveAll(time => now - time > TimeSpan.FromMinutes(15));
            if (restarts.Count < 3)
            {
                restarts.Add(now);
                log.Info("Lo vuelvo a arrancar.");
                Run();
                return;
            }
            SetStatus("ClosedBot · detenida");
            tray.ShowBalloonTip(10000, "ClosedBot se detuvo", "Haz clic aquí para volver a abrirla. Si vuelve a pasar, mira el registro (clic derecho en este icono).", ToolTipIcon.Warning);
        }

        /// Si se usaba una ClosedBot ajena y deja de responder, arranca la propia (para las rutinas).
        async void CheckExternal()
        {
            working = true;
            bool alive = true;
            try
            {
                alive = await Task.Run(() => server.RunningVersion() != null);
            }
            catch (Exception) { }
            working = false;
            if (!alive && !quitting)
            {
                log.Info("La otra ClosedBot dejó de responder; arranco la mía.");
                server.ForgetExternal();
                Run();
            }
        }

        async void Quit()
        {
            if (quitting) return;
            quitting = true;
            timer.Stop();
            SetStatus("ClosedBot · cerrando…");
            log.Info("Cerrando ClosedBot.");
            try
            {
                await Task.Run(() =>
                {
                    Browser.CloseWindows(paths);
                    server.Stop(12000);
                });
            }
            catch (Exception error)
            {
                log.Error(error.ToString());
            }
            tray.Visible = false;
            ExitThread();
        }

        void OnSessionEnding(object sender, SessionEndingEventArgs e)
        {
            if (quitting) return;
            quitting = true;
            log.Info("Windows se está cerrando; cierro ClosedBot.");
            try { server.Stop(4000); }
            catch (Exception) { }
        }

        void ToggleStartup()
        {
            bool enable = !Shortcuts.StartupEnabled;
            try
            {
                Shortcuts.SetStartup(paths, enable);
                log.Info(enable ? "Activé el inicio con Windows." : "Desactivé el inicio con Windows.");
            }
            catch (Exception error)
            {
                Dialogs.Warn("No pude cambiar el inicio con Windows.\n\n" + error.Message);
            }
            startupItem.Checked = Shortcuts.StartupEnabled;
        }

        void OpenLog()
        {
            try
            {
                using (Process.Start("notepad.exe", "\"" + paths.LogFile + "\"")) { }
            }
            catch (Exception error)
            {
                Dialogs.Warn("No pude abrir el registro (" + paths.LogFile + ").\n\n" + error.Message);
            }
        }

        void ShowFirstTip()
        {
            if (File.Exists(paths.TipMarker)) return;
            try { File.WriteAllText(paths.TipMarker, "Ya se mostró el aviso de la bandeja.\r\n"); }
            catch (Exception) { return; }
            tray.ShowBalloonTip(15000, "ClosedBot sigue aquí",
                "Si cierras la ventana, ClosedBot sigue funcionando para tus rutinas. Para volver, haz clic en este icono; para cerrarla del todo, clic derecho y «Salir».",
                ToolTipIcon.Info);
        }

        void SetStatus(string text)
        {
            tray.Text = text.Length > 63 ? text.Substring(0, 63) : text;
        }

        Icon LoadIcon()
        {
            try
            {
                if (File.Exists(paths.IconFile)) return new Icon(paths.IconFile, SystemInformation.SmallIconSize);
            }
            catch (Exception) { }
            try { return Icon.ExtractAssociatedIcon(paths.Exe); }
            catch (Exception) { }
            return SystemIcons.Application;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                SystemEvents.SessionEnding -= OnSessionEnding;
                timer.Dispose();
                tray.Visible = false;
                tray.Dispose();
                menu.Dispose();
                server.Kill();
                log.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    static class Native
    {
        public const int ASFW_ANY = -1;
        const int SW_RESTORE = 9;
        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool AllowSetForegroundWindow(int processId);

        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        static extern bool ShowWindowAsync(IntPtr window, int command);

        [DllImport("user32.dll")]
        static extern bool IsIconic(IntPtr window);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll")]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);

        [DllImport("kernel32.dll")]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr handle);

#pragma warning disable 0649
        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
#pragma warning restore 0649

        /// Un job que termina sus procesos cuando se cierra su último handle.
        public static IntPtr CreateKillOnCloseJob()
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return IntPtr.Zero;
            ExtendedLimits limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) return job;
            CloseHandle(job);
            return IntPtr.Zero;
        }

        public static void Focus(IntPtr window)
        {
            if (IsIconic(window)) ShowWindowAsync(window, SW_RESTORE);
            SetForegroundWindow(window);
        }
    }
}
