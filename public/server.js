import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import pg from "pg";

const app=express();
const port=process.env.PORT||3000;
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
const adminPin=process.env.ADMIN_PIN||"4729";
const cookieSecret=process.env.COOKIE_SECRET||"development-only-change-me";

app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],imgSrc:["'self'","data:"],styleSrc:["'self'","'unsafe-inline'"],scriptSrc:["'self'"]}}}));
app.use(express.json({limit:"100kb"}));app.use(cookieParser(cookieSecret));app.use(express.static("public"));

async function initialize(){await pool.query(`CREATE TABLE IF NOT EXISTS bookings(id UUID PRIMARY KEY,name VARCHAR(120) NOT NULL,phone VARCHAR(40) NOT NULL,email VARCHAR(180),braid_size VARCHAR(40) NOT NULL,braid_length VARCHAR(40) NOT NULL,finish VARCHAR(30) NOT NULL DEFAULT 'Standard',preferred_date DATE NOT NULL,preferred_time TIME NOT NULL,notes TEXT,status VARCHAR(20) NOT NULL DEFAULT 'Pending',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);await pool.query("CREATE INDEX IF NOT EXISTS bookings_created_at_idx ON bookings(created_at DESC)")}
const token=()=>crypto.createHmac("sha256",cookieSecret).update(adminPin).digest("hex");
const isAdmin=req=>req.signedCookies.owner_session===token();

app.get("/api/health",(_req,res)=>res.json({status:"ok"}));
app.post("/api/bookings",async(req,res)=>{try{const{name,phone,email,braidSize,braidLength,finish,preferredDate,preferredTime,notes}=req.body;if(!name||!phone||!braidSize||!braidLength||!finish||!preferredDate||!preferredTime)return res.status(400).json({error:"Please complete all required fields."});const id=crypto.randomUUID();await pool.query("INSERT INTO bookings(id,name,phone,email,braid_size,braid_length,finish,preferred_date,preferred_time,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,String(name).trim(),String(phone).trim(),email?String(email).trim():null,braidSize,braidLength,finish,preferredDate,preferredTime,notes?String(notes).trim():null]);res.status(201).json({message:"Booking request received.",id})}catch(error){console.error(error);res.status(500).json({error:"The booking could not be saved."})}});
app.post("/api/admin/login",(req,res)=>{if(String(req.body.pin)!==adminPin)return res.status(401).json({error:"Incorrect owner PIN."});res.cookie("owner_session",token(),{signed:true,httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"strict",maxAge:8*60*60*1000});res.json({ok:true})});
app.post("/api/admin/logout",(_req,res)=>{res.clearCookie("owner_session");res.json({ok:true})});
app.get("/api/admin/bookings",async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:"Owner login required."});try{const result=await pool.query("SELECT * FROM bookings ORDER BY created_at DESC");res.json({bookings:result.rows})}catch(error){console.error(error);res.status(500).json({error:"Could not load bookings."})}});
app.patch("/api/admin/bookings/:id",async(req,res)=>{if(!isAdmin(req))return res.status(401).json({error:"Owner login required."});const allowed=["Pending","Confirmed","Completed","Cancelled"];if(!allowed.includes(req.body.status))return res.status(400).json({error:"Invalid status."});try{const result=await pool.query("UPDATE bookings SET status=$1 WHERE id=$2 RETURNING id,status",[req.body.status,req.params.id]);if(!result.rowCount)return res.status(404).json({error:"Booking not found."});res.json(result.rows[0])}catch(error){console.error(error);res.status(500).json({error:"Could not update booking."})}});
app.get("/owner",(_req,res)=>res.sendFile(new URL("./public/owner.html",import.meta.url).pathname));
initialize().then(()=>app.listen(port,()=>console.log(`Braids by Athalia running on port ${port}`))).catch(error=>{console.error("Database initialization failed",error);process.exit(1)});
