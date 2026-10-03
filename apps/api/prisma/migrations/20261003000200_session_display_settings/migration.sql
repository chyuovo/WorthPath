ALTER TABLE User
 ADD COLUMN sessionHours INTEGER NOT NULL DEFAULT 168 COMMENT '登录有效时长（小时），范围 1 至 720',
 ADD COLUMN requireHiddenPassword BOOLEAN NOT NULL DEFAULT true COMMENT '查看隐藏项目是否需要再次验证密码',
 ADD COLUMN overviewCards JSON NULL COMMENT '总览显示的卡片键列表，NULL 表示默认全部显示';
