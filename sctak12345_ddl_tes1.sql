CREATE TABLE redef_tab (
  id           NUMBER,
  description  VARCHAR2(50),
  CONSTRAINT redef_tab_pk PRIMARY KEY (id)
);

CREATE INDEX redef_tab_desc_i ON redef_tab(description);

CREATE SEQUENCE redef_tab_seq;

CREATE OR REPLACE TRIGGER redef_tab_bir
BEFORE INSERT ON redef_tab
FOR EACH ROW
WHEN (new.id IS NULL)
BEGIN
  SELECT redef_tab_seq.NEXTVAL
  INTO   :new.id
  FROM   dual;
END;
/