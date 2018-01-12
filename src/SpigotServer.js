const config = require('../config.json');

const winston = require('winston');
const spawn = require('child_process').spawn;
const exec = require('child_process').exec;
const crypto = require('crypto');
const moment = require('moment');
const Promise = require('bluebird');
const StreamSplitter = require('stream-splitter');
const EventEmitter = require('events');
const mysql = require('mysql');
const fs = require('fs-extra');

const ServerProperties = require('./ServerProperties');

/**
 * This is the main Server class for instanciating new Spigot Servers
 */
class SpigotServer extends EventEmitter {
  /**
   * Create new Server
   * @param  {String} slug      A minimal computer-friendly name (e.g. my-spigot-server)
   * @param  {String} name      A full name for the server (e.g. My Spigot Server)
   * @param  {String} baseDir   Directory in which the server will be placed (in slug subdir)
   * @param  {String} jarFile   Jar file name to start the server
   * @param  {String} backupDir Directory in which backups will be placed (in slug subdir)
   * @param  {Integer} port      Port to bind the server to
   */
  constructor(slug, name, baseDir, jarFile, backupDir, template, port, isBungee) {
    super();
    this.slug = slug;
    this.name = name;
    this.baseDir = baseDir;
    this.workingDir = baseDir + '/' + slug;
    this.jarFile = jarFile;
    this.backupDir = backupDir;
    this.template = template;
    this.port = port;
    this.isBungee = isBungee;

    if (!this.isBungee) {
      this.serverProperties = new ServerProperties(this.workingDir + '/server.properties');
    }

    this.mysql = {
      user: slug,
      password: crypto.createHash('md5').update(slug).digest("hex"),
      db: slug,
    }

    this.isRunning = false;
    this.process = null;
    this.stdoutSplitter = null;
    this.sqlBackupProcess = null;
    this.backupProcess = null;
    this.monitorProcess = null;
  }

  /**
   * Bootstrap the new server with a template and a new mysql database
   * @return {Promise}
   */
  init() {
    return new Promise((resolve, reject) => {
      winston.info(`Initializing "${this.name}"(${this.slug})`);

      // Create MYSQL user & db
      let connection = mysql.createConnection(config.mysql);
      winston.info(`Creating MYSQL Database for "${this.name}"(${this.slug})`);
      Promise.resolve().then(() => {
        connection.connect((err) => {
          return new Promise((resolve, reject) => {
            if (err) {
              console.log(err);
              reject();
            } else {
              resolve();
            }
          });
        });
      }).then(() => {
        return new Promise((resolve, reject) => {
          connection.query(`CREATE DATABASE ${this.mysql.db}`, (error, results, fields) => {
            if (error) {
              console.log(error);
              reject();
            } else {
              resolve(results, fields)
            }
          });
        });
      }).then((results, fields) => {
        return new Promise((resolve, reject) => {
          connection.query(`GRANT ALL PRIVILEGES ON ${this.mysql.db} . * TO '${this.mysql.user}'@'localhost' IDENTIFIED BY '${this.mysql.password}'`, (error, results, fields) => {
            if (error) {
              console.log(error);
              reject();
            } else {
              resolve(results, fields)
            }
          });
        });
      }).then((results, fields) => {
        connection.end();
      });

      // Copy folder structure (template)
      fs.ensureDir(`${this.workingDir}`).then(() => {
        exec(`tar -xJf ${this.template} -C ${this.workingDir} --strip 1`, (error, stdout, stderr) => {
          if (error != null) {
            winston.error(`Error while cloning template for SpigotServer "${this.name}"(${this.slug}): ${stderr}`);
            reject('template-error');
            return;
          } else {
            winston.info(`Template cloned for SpigotServer "${this.name}"(${this.slug})`);


          }
        });
      });
    });
  }

/**
 * Sets the port the server will be listenning on
 */
  setPort() {
    return new Promise((resolve, reject) => {
      if (this.isBungee) {
        resolve()
      } else {
        this.serverProperties.loadProperties().then(() => {
          this.serverProperties.update('server-port', this.port);
          return this.serverProperties.saveProperties();
        }).then(() => {
          resolve();
        }).catch((err) => {
          reject(err);
        });
      }
    });
  }

  /**
   * Starts the server
   * @return {Promise}
   */
  start() {
    return new Promise((resolve,reject) => {
      if (this.isRunning) {
        winston.warn(`Tried to start SpigotServer "${this.name}"(${this.slug}) but it is already running on port ${this.port} with pid ${this.pid}`);
        reject('already-started');
        return;
      }

      this.setPort().then(() => {
        winston.info(`Starting SpigotServer "${this.name}"(${this.slug}) on port ${this.port}`);

        this.isRunning = true;
        this.process = spawn('java', [
          '-jar',
          this.jarFile,
          'nogui'
        ], {
          cwd: this.workingDir
        });

        this.process.on('error', (err) => {
          winston.error(`SpigotServer "${this.name}"(${this.slug}) error in process ${this.pid}: ${err}`);
        });

        this.process.on('exit', (code) => {
          if (code === 0) {
            this.isRunning = false;
            this.process = null;
            winston.info(`SpigotServer "${this.name}"(${this.slug}) stopped successfully`);
          } else {
            winston.info(`SpigotServer "${this.name}"(${this.slug}) stopped with error code ${code}`);
          }
        });

        this.stdoutSplitter = this.process.stdout.pipe(StreamSplitter('\n'));
        this.stdoutSplitter.on('token', (line) => {
          console.log(line.toString());
          this.emit('stdout', line.toString());
        });

        let doneRegex = /^\[[0-9]{2}:[0-9]{2}:[0-9]{2} INFO\]: Done \([0-9]+\.[0-9]+s\)! For help, type "help" or "?"$/;
        if (this.isBungee) {
          doneRegex = /[0-9]{2}:[0-9]{2}:[0-9]{2} \[INFO\] Listening on \/[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}.[0-9]{1,3}:[0-9]+/;
        }

        let filter = (line) => {
          line = line.toString();
          let m = doneRegex.exec(line);
          if (m) {
            this.stdoutSplitter.removeListener('token', filter);
            this.startMonitoring();
            resolve();
          }
        }
        this.stdoutSplitter.on('token', filter);
      });
    });
  }

  /**
   * Launch PIDSTAT  to monitor CPU, RAM and disk I/O
   * @return {}
   */
  startMonitoring() {
    if (!this.isRunning) {
      winston.warn(`Tried to monitor SpigotServer "${this.name}"(${this.slug}) but it is not running`);
      reject('not-running');
      return;
    }

    this.monitorProcess = spawn("pidstat", [
            "-h",
            "-r",
            "-u",
            "-d",
            "-s",
            "1",
            "-p",
            this.process.pid
            ]);

    this.monitorProcess.on('exit', (code) => {
      this.monitorProcess = null;
    })

    let stdoutSplitter = this.monitorProcess.stdout.pipe(StreamSplitter('\n'));
    stdoutSplitter.on("token", function(line) {
        line = line.toString();
        if (line[0] == '#') {
            return;
        }
        var raw = line.split(/\s+/);
        if (raw.length != 21) {
            return;
        }
        raw.shift();
        raw.shift();
        raw.shift();
        raw.shift();
        raw.pop();

        var obj = {
            'all': raw
        };

        this.emit('pidstat', obj);
    });
  }

  /**
   * Stops the server
   * @return {Promise}
   */
  stop() {
    return new Promise((resolve, reject) => {
      if (!this.isRunning) {
        winston.warn(`Tried to stop SpigotServer "${this.name}"(${this.slug}) but it is not running`);
        reject('not-running');
        return;
      }

      winston.info(`Stopping SpigotServer "${this.name}"(${this.slug}) on port ${this.port}`);

      if (this.monitorProcess != null) {
        this.stopMonitoring();
      }

      this.process.on('exit', (code) => {
        resolve();
      });
      if (this.isBungee) {
        this.executeCommand('end');
      } else {
        this.executeCommand('stop');
      }
    });
  }

  /**
   * Stop PIDSTAT
   * @return {}
   */
  stopMonitoring() {
    this.monitorProcess.kill('SIGTERM');
  }

  /**
   * Restarts the server
   * @return {Promise}
   */
  restart() {
    return new Promise((resolve, reject) => {
      if (!this.isRunning) {
        winston.warn(`Tried to restart SpigotServer "${this.name}"(${this.slug}) but it is not running`);
        reject('not-running');
        return;
      }

      winston.info(`Restarting SpigotServer "${this.name}"(${this.slug}) on port ${this.port}`);

      this.stop().then(() => {
        return this.start();
      }).then(() => {
        resolve();
      })
    })
  }

  /**
   * Executes a command on server (as console)
   * @param  {String} command A command
   * @return {}
   */
  executeCommand(command) {
    if (!this.isRunning) {
      winston.warn(`Tried to send command ${command} to SpigotServer "${this.name}"(${this.slug}) but it is not running`);
      return;
    }

    winston.info(`Sending command ${command} to SpigotServer "${this.name}"(${this.slug})`);

    this.process.stdin.write(command+'\n');
  }

  /**
   * Backs up the server + mysql database as a .tar.xz archive
   * @return {Promise}
   */
  backup() {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        winston.warn(`Tried to backup SpigotServer "${this.name}"(${this.slug}) but it is running`);
        reject('error-running');
        return;
      }

      winston.info(`Performing backup on SpigotServer "${this.name}"(${this.slug})`)

      exec(`mysqldump -u ${this.mysql.user} --password=${this.mysql.password} ${this.mysql.db} --single-transaction --default-character-set=utf8 > ${this.workingDir}/backup.sql`, (error, stdout, stderr) => {
        if (error != null) {
          winston.error(`Error while performing MYSQL backup on SpigotServer "${this.name}"(${this.slug}): ${stderr}`);
          reject('mysql-backup-error');
          return;
        } else {
          winston.info(`Performed MYSQL backup on SpigotServer "${this.name}"(${this.slug})`);

          let date = moment().format('YYYY-MM-DD-HH-mm-ss');
          exec(`tar -cJf ${this.backupDir}/${this.slug}/${date}.tar.xz ${this.workingDir}`, (error, stdout, stderr) => {
            if (error != null) {
              winston.error(`Error while performing minecraft backup on SpigotServer "${this.name}"(${this.slug}): ${stderr}`);
              reject('minecraft-backup-error');
              return;
            } else {
              winston.info(`Performed minecraft backup on SpigotServer "${this.name}"(${this.slug})`);

              resolve();
            }
          });
        }
      });
    });
  }



  status() {
    return {
      name: this.name,
      isRunning: this.isRunning
    }
  }
}

module.exports = SpigotServer;
