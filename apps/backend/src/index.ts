import cors from "cors";
import express from "express";
import { LoginSchema, SignUpSchema } from "./lib/schema";
import bcrypt from "bcrypt"
import { prisma } from "db";
import jwt from "jsonwebtoken";

const app = express();

app.use(express.json());
app.use(cors());

app.post("/signup" , async  ( req ,res) => {
    
    const {success , data } = SignUpSchema.safeParse(req.body);

    if(!success) {
        return res.status(400).json({
            success: false,
            data: null,
            error: "INVALID_REQUEST"
        })
    }
    // now   check if email exists or not 
    const checkUser = await prisma.user.findFirst({
        where:{
            email : data?.email
        }
    })

    if(checkUser) {
        return res.status(400).json({
            success: false,
            data: null,
            error: "EMAIL_ALREADY_EXISTS"       
        })
    }

    // hash the password
    const hashPassword = await bcrypt.hash(data.password , 10)

    // now create the user 
    
    const user = await prisma.user.create({
        data: {
            email : data.email,
            username: data.username,
            password: hashPassword,
            
        }
    })
    return res.status(201).json({
        success: true,
        data: user,
        error: null
        })
    
})

app.post("/login" ,  async (req , res ) => {
    const {success , data } = LoginSchema.safeParse(req.body);

    if(!success) {
        return res.status(400).json({
            success: false,
            data: null,
            error: "INVALID_REQUEST"
        })
    }

    // check if user exists
    const user = await prisma.user.findFirst({
        where:{
            email: data.email
        }
    })

    if(!user){
        return res.status(401).json({
            success: false,
            data: null,
            error: "EMAIL_DOESNOT_EXISTS"       
        })
    }

    const isPasswordTrue = await bcrypt.compare(data.password , user.password);

    if(!isPasswordTrue){
        return res.status(401).json({
            success: false,
            data: null,
            error: "INVALID_CREDENTIALS"
        })
    }

    // send the JWT_token
    const token =  jwt.sign({
        id : user.id,

    } , process.env.JWT_SECRET!)

    return res.status(200).json({
        success: true,
        data: { 
            token , 
            user 
            
        },
        error: null,      
    });


})


