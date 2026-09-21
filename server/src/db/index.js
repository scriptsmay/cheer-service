'use strict';

/**
 * 数据库后端门面（v1.3.0 迁移 Phase 2）
 * 按 DB_DRIVER 选择 mongo | postgres 后端，二者接口同形（TCB 兼容面），
 * 业务代码统一从这里 require，切换后端零业务改动。
 * mongo 后端全程保留为秒级回退通道。
 */

const config = require('../config/env');

module.exports =
  config.dbDriver === 'postgres' ? require('./postgres') : require('./mongo');
