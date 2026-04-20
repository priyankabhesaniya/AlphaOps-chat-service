const { Sequelize } = require('sequelize');

const sequelizeWrite = new Sequelize(
  process.env.DB_NAME || 'chat_db',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || 'wings123',
  {
    host: process.env.DB_HOST || 'localhost',
    dialect: 'mysql',
    logging: false,
    pool: {
      max: 10,
      min: 3,
      acquire: 30000,
      idle: 10000,
    },
  }
);

const sequelizeRead = new Sequelize(
  process.env.DB_NAME || 'chat_db',
  process.env.DB_READ_USER || process.env.DB_USER || 'root',
  process.env.DB_READ_PASSWORD || process.env.DB_PASSWORD || 'wings123',
  {
    host: process.env.DB_READ_HOST || process.env.DB_HOST || 'localhost',
    dialect: 'mysql',
    logging: false,
    pool: {
      max: 25,
      min: 5,
      acquire: 30000,
      idle: 10000,
    },
  }
);

module.exports = { sequelizeWrite, sequelizeRead };
